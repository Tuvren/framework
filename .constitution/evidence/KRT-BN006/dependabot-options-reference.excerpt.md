# Retained source excerpts: GitHub Docs Dependabot options reference
#
# This is a curated evidence file, not a complete upstream document. Each BEGIN/END marker identifies a contiguous range whose content between markers is byte-for-byte copied from the immutable upstream Markdown source named in support-provenance.md.

<!-- BEGIN upstream lines 26-34: required keys -->
### Required keys

| Key | Location | Purpose |
|--|--|--|
| `version` | Top level| {% data variables.product.prodname_dependabot %} configuration syntax to use. Always: `2`.|
| `updates` | Top level| Section where you define each `package-ecosystem` to update.|
| [`package-ecosystem`](#package-ecosystem-) | Under `updates` | Define a package manager to update. |
| [`directories` or `directory`](#directories-or-directory--) | Under each `package-ecosystem` entry | Define the location of the manifest or other definition files to update. |
| [`schedule.interval`](#schedule-) | Under each `package-ecosystem` entry | Define whether to look for version updates: `daily`, `weekly`, `monthly`{% ifversion fpt or ghes > 3.18 %}, `quarterly`, `semiannually`, `yearly`, or `cron`{% endif %}. |
<!-- END upstream lines 26-34 -->

<!-- BEGIN upstream lines 314-338: groups parameters -->
## `groups` {% octicon "versions" aria-label="Version updates" height="24" %} {% octicon "shield-check" aria-label="Security updates" height="24" %}

Define rules to create one or more sets of dependencies managed by a package manager, to group updates into fewer, targeted pull requests. For examples, see [AUTOTITLE](/code-security/tutorials/secure-your-dependencies/optimizing-pr-creation-version-updates).

{% data variables.product.prodname_dependabot %} default behavior:

* Open a single pull request for each dependency that needs to be updated to a newer version for version updates and for security updates.

When `groups` is used to define rules:

* All updates for dependencies that match a rule are combined in a single pull request.
* If a dependency matches more than one rule, it's included in the first group that it matches.
* Any outdated dependencies that do not match a rule are updated in individual pull requests.

Parameters | Purpose |
-------|-------------|
| `IDENTIFIER` | Define an identifier for the group to use in branch names and pull request titles. This must start and end with a letter, and can contain letters, pipes `\|`, underscores `_`, or hyphens `-`. |
| `applies-to` | Specify which type of update the group applies to. When undefined, defaults to version updates. Supported values: `version-updates` or `security-updates`. |
| `dependency-type` | Limit the group to a type. Supported values: `development` or `production`. |
| `exclude-patterns` | Define one or more patterns to exclude dependencies from the group. |
| {% ifversion dependabot-updates-group-by %} |
| `group-by` | Group updates across multiple directories. Supported value: `dependency-name`. |
| {% endif %} |
| `patterns` | Define one or more patterns to include dependencies with matching names. |
| `update-types` | Limit the group to one or more semantic versioning levels. Supported values: `minor`, `patch`, and `major`. |
<!-- END upstream lines 314-338 -->

<!-- BEGIN upstream lines 373-385: group patterns and update types -->
### `patterns` and `exclude-patterns` (`groups`)

Both options support using `*` as a wild card to define matches with dependency names. If a dependency matches both a pattern and an exclude-pattern, then it is excluded from the group.

### `update-types` (`groups`)

By default, a group will include updates for all semantic versions (SemVer). SemVer is an accepted standard for defining versions of software packages, in the form `x.y.z`. Dependabot assumes that versions in this form are always `major.minor.patch`.

* Use `patch` to include patch releases.
* Use `minor` to include minor releases.
* Use `major` to include major releases.

For examples, see [AUTOTITLE](/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/controlling-dependencies-updated#specifying-the-semantic-versioning-level-to-ignore).
<!-- END upstream lines 373-385 -->

<!-- BEGIN upstream lines 387-407: ignore parameters -->
## `ignore` {% octicon "versions" aria-label="Version updates" height="24" %} {% octicon "shield-check" aria-label="Security updates" height="24" %}

Use with the [`allow`](#allow--) option to define exactly which dependencies to maintain for a package ecosystem. {% data variables.product.prodname_dependabot %} checks for all allowed dependencies and then filters out any ignored dependencies or versions. So a dependency that is matched by both an allow and an ignore will be ignored. For examples, see [AUTOTITLE](/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/controlling-dependencies-updated#ignoring-specific-dependencies).

{% data variables.product.prodname_dependabot %} default behavior:

* {% octicon "versions" aria-hidden="true" aria-label="versions" %} All dependencies explicitly defined in a manifest are kept up to date by version updates.
* {% octicon "shield-check" aria-hidden="true" aria-label="shield-check" %} All dependencies defined in lock files with vulnerable dependencies are updated by security updates.

When `ignore` is used {% data variables.product.prodname_dependabot %} uses the following process:

1. Check for all explicitly **allowed** dependencies.
1. Then filter out any **ignored** dependencies or versions.

   If a dependency is matched by an `allow` and an `ignore` statement, then it is **ignored**.

| Parameters | Purpose |
|------------|---------|
| `dependency-name` | Ignore updates for dependencies with matching names, optionally using `*` to match zero or more characters. |
| `versions` | Ignore specific versions or ranges of versions. |
| `update-types` | Ignore updates to one or more semantic versioning levels. Supported values: `version-update:semver-patch`, `version-update:semver-minor`, and `version-update:semver-major`. |
<!-- END upstream lines 387-407 -->

<!-- BEGIN upstream lines 430-436: ignore update types -->
### `update-types` (`ignore`)

Specify which semantic versions (SemVer) to ignore. SemVer is an accepted standard for defining versions of software packages, in the form `x.y.z`. {% data variables.product.prodname_dependabot %} assumes that versions in this form are always `major.minor.patch`.

* Use `version-update:semver-patch` to include patch releases.
* Use `version-update:semver-minor` to include minor releases.
* Use `version-update:semver-major` to include major releases.
<!-- END upstream lines 430-436 -->

<!-- BEGIN upstream lines 552-590: package ecosystem values -->
* {% data variables.product.prodname_dependabot %} opens pull requests up to the defined integer value. A large value can be set to effectively remove the open pull request limit.
* You can temporarily disable version updates for a package manager by setting this option to zero, see [Disabling {% data variables.product.prodname_dependabot_version_updates %}](/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates#disabling-dependabot-version-updates).

## `package-ecosystem` {% octicon "versions" aria-label="Version updates only" height="24" %}

<!--Note: When making updates to this section, please make sure any changes are also reflected in `data/reusables/dependabot/supported-package-managers.md`.-->

**Required option.** Define one `package-ecosystem` element for each package manager that you want {% data variables.product.prodname_dependabot %} to monitor for new versions. The repository must also contain a dependency manifest or lock file for each package manager, see [Example `dependabot.yml` file](/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-version-updates#example-dependabotyml-file).

Package manager | YAML value      | Supported versions |
---------------|------------------|:------------------:|
| {% ifversion dependabot-bazel-support %} |
| Bazel         | `bazel`          | v7, v8, v9               |
| {% endif %} |
| Bun | `bun`         | >=v1.1.39              |
| Bundler | `bundler` | v2 |
| Cargo       | `cargo`          | v1               |
| Composer       | `composer`       | v2         |
| {% ifversion dependabot-conda-support %} |
| Conda         | `conda`          | Not applicable               |
| {% endif %} |
| {% ifversion dependabot-deno-support %} |
| Deno         | `deno`          | >=v2               |
| {% endif %} |
| Dev containers | `devcontainers`         | Not applicable               |
| Docker         | `docker`         | v1               |
| Docker Compose | `docker-compose`         | v2, v3               |
| .NET SDK       | `dotnet-sdk`         | >=.NET Core 3.1           |
| {% ifversion dependabot-helm-support %} |
| Helm Charts            | `helm`            | v3               |
| {% endif %} |
| Hex            | `mix`            | v1               |
| {% ifversion dependabot-julia-support %} |
| Julia                  | `julia`           | >=v1.10               |
| {% endif %} |
| elm-package    | `elm`            | v0.19            |
| git submodule  | `gitsubmodule`   | Not applicable |
| {% data variables.product.prodname_actions %}  | `github-actions` | Not applicable |
| Go modules     | `gomod`          | v1               |
<!-- END upstream lines 552-590 -->
