{ pkgs, ... }:
{
  languages.rust = {
    enable = true;
    toolchainFile = ./rust-toolchain.toml;
  };

  languages.go.enable = true;

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
