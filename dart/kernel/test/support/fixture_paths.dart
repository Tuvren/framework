// Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/// Locates `spec/conformance/kernel/fixtures/`, the authority location for
/// the deterministic kernel-record fixtures, from wherever `dart test`
/// happens to have been invoked. Mirrors `go/kernel/fixtures_test.go`'s
/// `fixtureDir` constant, but walks up from the working directory instead
/// of hardcoding a fixed number of `..` segments: `dart test` sets the
/// working directory to the package root (`dart/kernel`) for every
/// invocation this repository uses (`dart test` run directly, and the
/// `kernel-dart-kernel:test` Nx target, which sets `cwd: "dart/kernel"`),
/// but walking up to the sentinel workspace `pubspec.yaml` keeps this
/// robust against being invoked from a different working directory too
/// (for example an IDE run configuration).
library;

import 'dart:io';

/// Walks up from [Directory.current] until it finds a `pubspec.yaml` that
/// declares a `workspace:` field -- the sentinel for this repository's Dart
/// pub workspace root (`/pubspec.yaml`, which lists `dart/kernel` and its
/// sibling packages as workspace members).
Directory repositoryRoot() {
  var candidate = Directory.current;
  for (var i = 0; i < 16; i++) {
    final pubspec = File('${candidate.path}/pubspec.yaml');
    if (pubspec.existsSync() &&
        pubspec.readAsStringSync().contains('workspace:')) {
      return candidate;
    }
    final parent = candidate.parent;
    if (parent.path == candidate.path) break;
    candidate = parent;
  }
  throw StateError(
    'kernel test: could not locate the repository root (a pubspec.yaml '
    'with a workspace: field) by walking up from ${Directory.current.path}',
  );
}

/// `spec/conformance/kernel/fixtures/` under [repositoryRoot].
Directory kernelFixturesDir() =>
    Directory('${repositoryRoot().path}/spec/conformance/kernel/fixtures');
