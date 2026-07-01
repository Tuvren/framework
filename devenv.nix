{ pkgs, ... }:
{
  languages.rust = {
    enable = true;
    toolchainFile = ./rust-toolchain.toml;
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
    pkgs.weaver
  ];
}
