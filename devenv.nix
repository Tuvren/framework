{ pkgs, ... }:
{
  packages = [
    pkgs.bun
    pkgs.buf
    pkgs.nodejs_24
    pkgs.protoc-gen-es
    pkgs.weaver
  ];
}
