{ pkgs, ... }:
{
  packages = [
    pkgs.bun
    pkgs.nodejs_24
    pkgs.weaver
  ];
}
