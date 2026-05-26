import { Prisma, PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { z } from "zod";
import { logger } from "@formbricks/logger";

/**
 * Non-interactive startup bootstrap.
 *
 * When all four `FORMBRICKS_BOOTSTRAP_*` env vars are set, upserts the admin
 * User (by email) and the first Organization (by exact name + owner-membership
 * presence). When the trigger var (`FORMBRICKS_BOOTSTRAP_EMAIL`) is empty, the
 * script is a no-op so the container falls through to the interactive
 * `/setup/intro` flow as today.
 *
 * Mirrors the shape of the Postal fork's `UserCreator` non-interactive mode:
 * - Single gate var decides interactive-vs-env mode.
 * - Partial env (some required vars missing) fails fast with a clear message.
 * - Validation failures (malformed email, weak password) fail fast.
 * - Idempotent: re-running the same env produces the same end state without
 *   creating duplicate users or organizations.
 *
 * Why a bcryptjs hash here (rather than reusing `@/lib/auth.hashPassword`)?
 * The web app's hashing helper lives in the Next.js app bundle and pulls in
 * server-only modules (audit logging, Sentry, etc.). This script runs from
 * the standalone `packages/database/dist/scripts/` build in the runtime
 * image, before `next start`, so it must stay self-contained. The cost
 * factor (12) and bcrypt algorithm match `apps/web/lib/auth.ts`.
 */

const ENV_PREFIX = "FORMBRICKS_BOOTSTRAP_";

const EMAIL_VAR = `${ENV_PREFIX}EMAIL` as const;
const NAME_VAR = `${ENV_PREFIX}NAME` as const;
const PASSWORD_VAR = `${ENV_PREFIX}PASSWORD` as const;
const ORG_NAME_VAR = `${ENV_PREFIX}ORG_NAME` as const;

const REQUIRED_VARS = [EMAIL_VAR, NAME_VAR, PASSWORD_VAR, ORG_NAME_VAR] as const;

// Matches `ZUserName` in packages/types/user.ts.
const ZBootstrapName = z
  .string()
  .trim()
  .min(1)
  .regex(/^[\p{L}\p{M} ',()\d-]+$/u, "Invalid name format");

// Matches `ZUserEmail` in packages/types/user.ts.
const ZBootstrapEmail = z.email().max(255);

// Matches `ZUserPassword` in packages/types/user.ts. We re-declare here
// rather than importing from `@formbricks/types` because this script is
// bundled into a standalone CommonJS entry that ships in the runtime image
// before the Next.js app is available.
const ZBootstrapPassword = z
  .string()
  .min(8, { error: "Password must be at least 8 characters long" })
  .max(128, { error: "Password must be 128 characters or less" })
  .regex(/^(?=.*[A-Z])(?=.*\d).*$/, "Password must contain an uppercase letter and a digit");

const ZBootstrapOrgName = z.string().trim().min(1, "Organization name must not be empty");

interface BootstrapConfig {
  email: string;
  name: string;
  password: string;
  orgName: string;
}

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

const shouldRunBootstrap = (env: NodeJS.ProcessEnv): boolean => isSet(env[EMAIL_VAR]);

const collectMissingVars = (env: NodeJS.ProcessEnv): string[] =>
  REQUIRED_VARS.filter((key) => !isSet(env[key]));

const readBootstrapConfig = (env: NodeJS.ProcessEnv): BootstrapConfig => {
  const missing = collectMissingVars(env);
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(", ")}`);
  }

  const rawEmail = env[EMAIL_VAR];
  const rawName = env[NAME_VAR];
  const rawPassword = env[PASSWORD_VAR];
  const rawOrgName = env[ORG_NAME_VAR];

  if (
    rawEmail === undefined ||
    rawName === undefined ||
    rawPassword === undefined ||
    rawOrgName === undefined
  ) {
    // `collectMissingVars` already covers this; the narrow keeps the type checker happy.
    throw new Error("internal error: required env vars not set after presence check");
  }

  const email = ZBootstrapEmail.parse(rawEmail.trim().toLowerCase());
  const name = ZBootstrapName.parse(rawName);
  const password = ZBootstrapPassword.parse(rawPassword);
  const orgName = ZBootstrapOrgName.parse(rawOrgName);

  return { email, name, password, orgName };
};

const upsertAdminUser = async (
  prisma: PrismaClient,
  config: BootstrapConfig
): Promise<{ id: string; created: boolean }> => {
  const hashedPassword = await hash(config.password, 12);
  const now = new Date();

  const existing = await prisma.user.findUnique({
    where: { email: config.email },
    select: { id: true },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: config.name,
        password: hashedPassword,
        // Email already verified — we're scripting; if you wanted email
        // verification you would have used the interactive flow.
        emailVerified: now,
      },
    });
    return { id: existing.id, created: false };
  }

  const created = await prisma.user.create({
    data: {
      email: config.email,
      name: config.name,
      password: hashedPassword,
      emailVerified: now,
      identityProvider: "email",
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
};

const upsertFirstOrganization = async (
  prisma: PrismaClient,
  userId: string,
  orgName: string
): Promise<{ id: string; created: boolean }> => {
  // Idempotency key: an Organization with exact name and a Membership where
  // this user is owner. If one exists, no-op. Otherwise create both.
  const existing = await prisma.organization.findFirst({
    where: {
      name: orgName,
      memberships: {
        some: { userId, role: "owner" },
      },
    },
    select: { id: true },
  });

  if (existing) {
    return { id: existing.id, created: false };
  }

  const created = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: orgName,
        billing: {
          create: {
            // Mirrors `getDefaultOrganizationBilling()` in
            // apps/web/lib/organization/service.ts for the self-hosted
            // (non-cloud) defaults.
            limits: { workspaces: 3, monthly: { responses: 1500 } },
            stripeCustomerId: null,
            usageCycleAnchor: null,
          },
        },
      },
      select: { id: true },
    });

    await tx.membership.create({
      data: {
        organizationId: organization.id,
        userId,
        role: "owner",
        accepted: true,
      },
    });

    return organization;
  });

  return { id: created.id, created: true };
};

export const runBootstrap = async (
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv
): Promise<{ skipped: boolean }> => {
  if (!shouldRunBootstrap(env)) {
    logger.info("Formbricks bootstrap skipped (FORMBRICKS_BOOTSTRAP_EMAIL not set)");
    return { skipped: true };
  }

  logger.info("Formbricks bootstrap starting (FORMBRICKS_BOOTSTRAP_EMAIL set)");

  let config: BootstrapConfig;
  try {
    config = readBootstrapConfig(env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => issue.message).join("; ");
      throw new Error(`Formbricks bootstrap validation failed: ${issues}`);
    }
    throw error;
  }

  const userResult = await upsertAdminUser(prisma, config);
  if (userResult.created) {
    logger.info({ email: config.email, userId: userResult.id }, "Formbricks bootstrap created admin user");
  } else {
    logger.info(
      { email: config.email, userId: userResult.id },
      "Formbricks bootstrap updated existing admin user"
    );
  }

  const orgResult = await upsertFirstOrganization(prisma, userResult.id, config.orgName);
  if (orgResult.created) {
    logger.info(
      { organizationId: orgResult.id, name: config.orgName },
      "Formbricks bootstrap created first organization"
    );
  } else {
    logger.info(
      { organizationId: orgResult.id, name: config.orgName },
      "Formbricks bootstrap found existing organization owned by this user; nothing to do"
    );
  }

  return { skipped: false };
};

const main = async (): Promise<void> => {
  const prisma = new PrismaClient();
  try {
    await runBootstrap(prisma, process.env);
  } finally {
    await prisma.$disconnect();
  }
};

// Avoid running side-effects when imported by the test suite. The bundler
// emits both a CJS (.cjs) bundle and an ESM (.js) bundle because
// packages/database is `"type": "module"`. Each module system exposes
// a different way to ask "am I the entrypoint?":
//   - CJS: `require.main === module`.
//   - ESM: compare `import.meta.url` to `process.argv[1]` (resolved to a
//     file:// URL).
// Tests import the module from vitest (which is neither path), so neither
// branch fires and `main()` stays dormant.
const isDirectInvocation = (): boolean => {
  // ESM path first — bundled .js entry. `import.meta.url` is the
  // script's own file:// URL; `process.argv[1]` is the path the user
  // passed to `node`. They match when the script was the entrypoint.
  // Tests import the module from vitest (different argv[1]) so this
  // returns false there.
  if (typeof import.meta !== "undefined" && typeof import.meta.url === "string") {
    const argv1 = process.argv[1];
    if (argv1) {
      const entrypointUrl = new URL(`file://${argv1}`).href;
      return import.meta.url === entrypointUrl;
    }
    return false;
  }
  // CJS fallback — bundled .cjs entry. `require.main === module` is
  // the canonical Node self-detection in CommonJS.
  if (typeof require !== "undefined" && typeof module !== "undefined") {
    return require.main === module;
  }
  return false;
};

if (isDirectInvocation()) {
  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      // Provide a clear failure mode for the container entrypoint.
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error(
          { code: error.code, message: error.message },
          "Formbricks bootstrap failed (Prisma error)"
        );
      } else if (error instanceof Error) {
        logger.error({ message: error.message }, "Formbricks bootstrap failed");
      } else {
        logger.error({ error }, "Formbricks bootstrap failed");
      }
      process.exit(1);
    });
}
