{ pkgs, ... }:
{
  languages.rust = {
    enable = true;
    toolchainFile = ./rust-toolchain.toml;
  };

  # Go and Python ride nixpkgs' current default toolchains, reproducible via
  # devenv.lock rather than an in-file version pin (unlike Rust, whose
  # rust-toolchain.toml is authoritative). If a future nixpkgs bump moves the
  # provided Go below the root go.work's `go` directive (or shifts Python in a
  # way uv.lock resolution rejects), pin explicitly via languages.go.package /
  # languages.python.version at that point.
  languages.go.enable = true;

  # Dart rides the nixpkgs default SDK for the same reason as Go/Python
  # above; the root pubspec.yaml workspace plus the committed pubspec.lock
  # own dependency truth for the dart/ implementation line.
  languages.dart.enable = true;

  languages.python = {
    enable = true;
    uv.enable = true;
  };

  services.postgres = {
    enable = true;
    initialDatabases = [
      {
        name = "tuvren_runtime";
      }
    ];
  };

  packages = [
    (pkgs.writeShellScriptBin "bazel" ''exec ${pkgs.bazelisk}/bin/bazelisk "$@"'')
    pkgs.bun
    pkgs.buf
    pkgs.nodejs_24
    pkgs.protobuf
    pkgs.protoc-gen-es
    # kernel-testkit's production-path isolation test spawns `rg`; declare it
    # here so the dependency is hermetic instead of ambient host tooling
    # (absent on CI runners inside `devenv shell`).
    pkgs.ripgrep
    pkgs.weaver
  ];
}
