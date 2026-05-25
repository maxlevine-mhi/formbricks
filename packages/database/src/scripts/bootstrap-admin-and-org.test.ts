import { describe, expect, test, vi } from "vitest";
import { runBootstrap } from "./bootstrap-admin-and-org";

// Lightweight stand-in for `PrismaClient`. We only exercise the methods the
// bootstrap touches; using `unknown as PrismaClient` keeps the type checker
// out of our way without leaking `: unknown` into production code.

const HAPPY_ENV = {
  FORMBRICKS_BOOTSTRAP_EMAIL: "admin@example.com",
  FORMBRICKS_BOOTSTRAP_NAME: "Admin User",
  FORMBRICKS_BOOTSTRAP_PASSWORD: "Sup3rSecret!",
  FORMBRICKS_BOOTSTRAP_ORG_NAME: "MHI",
} as const;

interface StubUserRow {
  id: string;
  email: string;
  name: string;
  password: string;
  emailVerified: Date | null;
}

interface StubOrgRow {
  id: string;
  name: string;
}

interface StubMembershipRow {
  organizationId: string;
  userId: string;
  role: "owner" | "member";
  accepted: boolean;
}

interface StubDb {
  users: StubUserRow[];
  organizations: StubOrgRow[];
  memberships: StubMembershipRow[];
}

const makeStubPrisma = (db: StubDb) => {
  const tx = {
    organization: {
      create: vi.fn(async ({ data }: { data: { name: string } }) => {
        const row: StubOrgRow = { id: `org_${db.organizations.length + 1}`, name: data.name };
        db.organizations.push(row);
        return { id: row.id };
      }),
    },
    membership: {
      create: vi.fn(async ({ data }: { data: StubMembershipRow }) => {
        db.memberships.push({ ...data });
        return data;
      }),
    },
  };

  const prismaStub = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) {
          return db.users.find((u) => u.email === where.email) ?? null;
        }
        if (where.id) {
          return db.users.find((u) => u.id === where.id) ?? null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Omit<StubUserRow, "id"> & { identityProvider?: string } }) => {
        const row: StubUserRow = {
          id: `user_${db.users.length + 1}`,
          email: data.email,
          name: data.name,
          password: data.password,
          emailVerified: data.emailVerified ?? null,
        };
        db.users.push(row);
        return { id: row.id };
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Pick<StubUserRow, "name" | "password" | "emailVerified">>;
        }) => {
          const existing = db.users.find((u) => u.id === where.id);
          if (!existing) throw new Error("not found");
          if (data.name !== undefined) existing.name = data.name;
          if (data.password !== undefined) existing.password = data.password;
          if (data.emailVerified !== undefined) existing.emailVerified = data.emailVerified;
          return existing;
        }
      ),
    },
    organization: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { name: string; memberships: { some: { userId: string; role: string } } };
        }) => {
          const target = db.organizations.find((o) => o.name === where.name);
          if (!target) return null;
          const ownerMembership = db.memberships.find(
            (m) =>
              m.organizationId === target.id &&
              m.userId === where.memberships.some.userId &&
              m.role === where.memberships.some.role
          );
          return ownerMembership ? { id: target.id } : null;
        }
      ),
    },
    $transaction: vi.fn(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx)),
    $disconnect: vi.fn(async () => undefined),
  };

  // Cast through `unknown` to satisfy the `PrismaClient` parameter without
  // dragging the full Prisma type surface into this test.
  return { prisma: prismaStub as unknown as Parameters<typeof runBootstrap>[0], tx, db };
};

const emptyDb = (): StubDb => ({ users: [], organizations: [], memberships: [] });

describe("runBootstrap", () => {
  test("no-op when FORMBRICKS_BOOTSTRAP_EMAIL is unset (interactive fallback)", async () => {
    const { prisma, db } = makeStubPrisma(emptyDb());

    const result = await runBootstrap(prisma, {});

    expect(result.skipped).toBe(true);
    expect(db.users).toHaveLength(0);
    expect(db.organizations).toHaveLength(0);
  });

  test("creates admin user + first org when all four vars set", async () => {
    const { prisma, db } = makeStubPrisma(emptyDb());

    const result = await runBootstrap(prisma, { ...HAPPY_ENV });

    expect(result.skipped).toBe(false);
    expect(db.users).toHaveLength(1);
    expect(db.users[0].email).toBe("admin@example.com");
    expect(db.users[0].name).toBe("Admin User");
    expect(db.users[0].password).not.toBe("Sup3rSecret!"); // hashed
    expect(db.users[0].emailVerified).toBeInstanceOf(Date);
    expect(db.organizations).toHaveLength(1);
    expect(db.organizations[0].name).toBe("MHI");
    expect(db.memberships).toHaveLength(1);
    expect(db.memberships[0]).toMatchObject({
      userId: db.users[0].id,
      organizationId: db.organizations[0].id,
      role: "owner",
      accepted: true,
    });
  });

  test("idempotent: re-running with same env does not create a second org or duplicate user", async () => {
    const db = emptyDb();
    const { prisma } = makeStubPrisma(db);

    await runBootstrap(prisma, { ...HAPPY_ENV });
    const firstUserId = db.users[0].id;
    const firstOrgId = db.organizations[0].id;

    await runBootstrap(prisma, { ...HAPPY_ENV });

    expect(db.users).toHaveLength(1);
    expect(db.users[0].id).toBe(firstUserId);
    expect(db.organizations).toHaveLength(1);
    expect(db.organizations[0].id).toBe(firstOrgId);
    expect(db.memberships).toHaveLength(1);
  });

  test("updates name + password on existing user, leaves org untouched", async () => {
    const db = emptyDb();
    const { prisma } = makeStubPrisma(db);

    await runBootstrap(prisma, { ...HAPPY_ENV });
    const originalHash = db.users[0].password;

    await runBootstrap(prisma, { ...HAPPY_ENV, FORMBRICKS_BOOTSTRAP_PASSWORD: "Diff3rentPass!" });

    expect(db.users).toHaveLength(1);
    expect(db.users[0].password).not.toBe(originalHash);
    expect(db.organizations).toHaveLength(1);
    expect(db.memberships).toHaveLength(1);
  });

  test("partial env (EMAIL only) fails fast with a clear message", async () => {
    const { prisma } = makeStubPrisma(emptyDb());

    await expect(
      runBootstrap(prisma, { FORMBRICKS_BOOTSTRAP_EMAIL: "admin@example.com" })
    ).rejects.toThrow(/missing required environment variables/);
  });

  test("partial env (everything except ORG_NAME) fails fast", async () => {
    const { prisma } = makeStubPrisma(emptyDb());

    await expect(
      runBootstrap(prisma, {
        FORMBRICKS_BOOTSTRAP_EMAIL: HAPPY_ENV.FORMBRICKS_BOOTSTRAP_EMAIL,
        FORMBRICKS_BOOTSTRAP_NAME: HAPPY_ENV.FORMBRICKS_BOOTSTRAP_NAME,
        FORMBRICKS_BOOTSTRAP_PASSWORD: HAPPY_ENV.FORMBRICKS_BOOTSTRAP_PASSWORD,
      })
    ).rejects.toThrow(/missing required environment variables.*ORG_NAME/);
  });

  test("malformed email fails validation", async () => {
    const { prisma } = makeStubPrisma(emptyDb());

    await expect(
      runBootstrap(prisma, { ...HAPPY_ENV, FORMBRICKS_BOOTSTRAP_EMAIL: "not-an-email" })
    ).rejects.toThrow(/validation failed/);
  });

  test("weak password (no uppercase + digit) fails validation", async () => {
    const { prisma } = makeStubPrisma(emptyDb());

    await expect(
      runBootstrap(prisma, { ...HAPPY_ENV, FORMBRICKS_BOOTSTRAP_PASSWORD: "tooweak1" })
    ).rejects.toThrow(/validation failed/);
  });

  test("short password fails validation", async () => {
    const { prisma } = makeStubPrisma(emptyDb());

    await expect(
      runBootstrap(prisma, { ...HAPPY_ENV, FORMBRICKS_BOOTSTRAP_PASSWORD: "Aa1" })
    ).rejects.toThrow(/validation failed/);
  });

  test("empty org name fails validation", async () => {
    const { prisma } = makeStubPrisma(emptyDb());

    await expect(
      runBootstrap(prisma, { ...HAPPY_ENV, FORMBRICKS_BOOTSTRAP_ORG_NAME: "   " })
    ).rejects.toThrow(/validation failed/);
  });

  test("trigger var present but blank is treated as unset (interactive fallback)", async () => {
    const { prisma, db } = makeStubPrisma(emptyDb());

    const result = await runBootstrap(prisma, {
      FORMBRICKS_BOOTSTRAP_EMAIL: "   ",
      FORMBRICKS_BOOTSTRAP_NAME: HAPPY_ENV.FORMBRICKS_BOOTSTRAP_NAME,
      FORMBRICKS_BOOTSTRAP_PASSWORD: HAPPY_ENV.FORMBRICKS_BOOTSTRAP_PASSWORD,
      FORMBRICKS_BOOTSTRAP_ORG_NAME: HAPPY_ENV.FORMBRICKS_BOOTSTRAP_ORG_NAME,
    });

    expect(result.skipped).toBe(true);
    expect(db.users).toHaveLength(0);
  });

  test("email is normalised to lowercase before upsert", async () => {
    const db = emptyDb();
    const { prisma } = makeStubPrisma(db);

    await runBootstrap(prisma, { ...HAPPY_ENV, FORMBRICKS_BOOTSTRAP_EMAIL: "Admin@Example.COM" });

    expect(db.users[0].email).toBe("admin@example.com");
  });
});
