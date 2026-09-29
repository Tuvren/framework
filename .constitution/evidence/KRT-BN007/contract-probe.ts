import { resolve } from "node:path";
import { file } from "bun";

const PROBE_NAME = "KRT-BN007 contract probe";
const NEXT_SECTION_HEADING_PATTERN = /^## /m;
const STREAM_WS_PACKAGE_PATTERN = /@tuvren\/stream-ws/;

const ROOT = process.cwd();
const README_PATH = `${ROOT}/README.md`;
const GUIDE_PATH = `${ROOT}/docs/guides/publishing-and-adopter-onboarding.md`;

const failures: string[] = [];

function requireClaim(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

function section(markdown: string, heading: string): string {
  const headingPattern = new RegExp(
    `^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "m"
  );
  const start = markdown.search(headingPattern);
  if (start === -1) {
    return "";
  }
  const remainder = markdown.slice(start);
  const next = remainder.slice(1).search(NEXT_SECTION_HEADING_PATTERN);
  return next === -1 ? remainder : remainder.slice(0, next + 1);
}

function fencedCodeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? ""
  );
}

function hasAuthorityLink(markdown: string, path: string): boolean {
  return markdown.includes(`](${path})`);
}

async function requireAuthorityTargets(
  markdown: string,
  sourceDirectory: string,
  sourceName: string
): Promise<void> {
  const authorityTargets = [...markdown.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1] ?? "")
    .filter(
      (target) =>
        target.startsWith(".constitution/") ||
        target.startsWith("../../.constitution/") ||
        target.startsWith("spec/")
    );

  for (const target of authorityTargets) {
    const [path] = target.split("#", 1);
    if (path === undefined || path === "") {
      failures.push(`${sourceName} has an empty authority-link target.`);
      continue;
    }
    requireClaim(
      await file(resolve(sourceDirectory, path)).exists(),
      `${sourceName} authority-link target exists: ${target}.`
    );
  }
}

const [readme, guide] = await Promise.all([
  file(README_PATH).text(),
  file(GUIDE_PATH).text(),
]);
await Promise.all([
  requireAuthorityTargets(readme, ROOT, "README"),
  requireAuthorityTargets(guide, `${ROOT}/docs/guides`, "Adopter guide"),
]);

const firstTurnLink =
  "docs/guides/publishing-and-adopter-onboarding.md#2-install-and-run-a-first-turn";
const architectureHeading = readme.indexOf("## Architecture");
const firstTurnPath = readme.indexOf(firstTurnLink);
requireClaim(
  firstTurnPath !== -1 && firstTurnPath < architectureHeading,
  "README links to the first-Turn walkthrough before Architecture."
);
requireClaim(
  /Tuvren is an embeddable, durable agent framework over a kernel\./.test(
    readme
  ),
  "README states the approved one-line positioning."
);
requireClaim(
  /\[ReAct\]\([^)]*\) is one runner\./.test(readme),
  "README describes ReAct as one runner."
);
requireClaim(
  /TypeScript is the full framework implementation\./.test(readme),
  "README names TypeScript as the full framework implementation."
);
requireClaim(
  /Rust, Go, Python, and Dart are kernel ports\b/.test(readme),
  "README names Rust, Go, Python, and Dart as kernel ports."
);
requireClaim(
  /There is no Rust framework implementation\./.test(readme),
  "README explicitly excludes a Rust framework implementation."
);
requireClaim(
  hasAuthorityLink(
    readme,
    ".constitution/tech-spec/adrs/ADR-0033-typescript-freeze-uses-product-proof-platform-and-porta.md"
  ) &&
    hasAuthorityLink(readme, ".constitution/prd/vision.md") &&
    hasAuthorityLink(readme, ".constitution/architecture/strategy.md") &&
    hasAuthorityLink(readme, ".constitution/tech-spec/guidelines.md") &&
    hasAuthorityLink(readme, "spec/kernel/authority-packet.json") &&
    hasAuthorityLink(readme, "spec/runners/react/authority-packet.json"),
  "README links its positioning and language claims to the declared authority."
);

const published = section(
  guide,
  "1. What is published, and what the tiers mean"
);
const firstTurn = section(guide, "2. Install and run a first Turn");
const stable = section(
  guide,
  "3. Stable core vs. `@experimental` surfaces (ADR-0056)"
);
requireClaim(
  published.length > 0 && firstTurn.length > 0 && stable.length > 0,
  "Guide preserves sections 1, 2, and 3."
);

requireClaim(
  /verified against the actually-published `0\.1\.0` packages on registry\.npmjs\.org/.test(
    firstTurn
  ),
  "Guide preserves the historically verified published 0.1.0 walkthrough."
);

for (const name of [
  "@tuvren/stream-ws",
  "@tuvren/host-session",
  "@tuvren/remote-session",
  "@tuvren/session-client",
]) {
  requireClaim(
    published.includes(name),
    `Guide section 1 identifies ${name} as a private session package.`
  );
}
requireClaim(
  /private experimental repository packages/i.test(published) &&
    /Do not install or import them\./.test(published),
  "Guide says the four private session packages remain experimental repository packages and are not installable."
);
for (const [name, body] of [
  ["section 1", published],
  ["section 2", firstTurn],
] as const) {
  requireClaim(
    fencedCodeBlocks(body).every(
      (block) => !STREAM_WS_PACKAGE_PATTERN.test(block)
    ),
    `Guide ${name} never offers @tuvren/stream-ws in an installation command.`
  );
}

requireClaim(
  /SQLite.*local.*single-writer/i.test(firstTurn) &&
    /PostgreSQL.*multi-worker/i.test(firstTurn) &&
    /backend-authoritative lease clock/i.test(firstTurn) &&
    /same-scope writers.*serialized/i.test(firstTurn),
  "Guide section 2 states the SQLite/PostgreSQL deployment posture without promising parallel same-scope writers."
);
requireClaim(
  hasAuthorityLink(
    firstTurn,
    "../../.constitution/tech-spec/adrs/ADR-0050-backend-authoritative-lease-clock-for-shared-backends.md"
  ) &&
    hasAuthorityLink(
      firstTurn,
      "../../.constitution/tech-spec/adrs/ADR-0067-postgres-relational-row-per-record-storage.md"
    ),
  "Guide section 2 links the backend topology to ADR-0050 and ADR-0067."
);

requireClaim(
  /While a public package is at 0\.x, a breaking change to an untagged stable or frozen export bumps the MINOR version/is.test(
    stable
  ) &&
    /fixes, additive changes, and graduations.*PATCH version/is.test(stable) &&
    /@experimental.*may change in any release/is.test(stable),
  "Guide section 3 states ADR-0069's exact 0.x MINOR/PATCH/experimental policy."
);
requireClaim(
  hasAuthorityLink(
    stable,
    "../../.constitution/tech-spec/adrs/ADR-0069-public-release-discipline.md"
  ),
  "Guide section 3 links its release policy to ADR-0069."
);

if (failures.length > 0) {
  console.error(`${PROBE_NAME}: contract probe failed`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`${PROBE_NAME}: contract probe passed`);
