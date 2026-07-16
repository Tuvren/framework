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

// Command main is the Dart kernel conformance adapter entry point: one
// JSON-RPC 2.0 response line on stdout for every request line on stdin,
// until stdin closes. See lib/adapter.dart for the protocol handling.

import 'dart:convert';
import 'dart:io';

import 'package:tuvren_kernel_adapter/adapter.dart';

Future<void> main() async {
  final lines = stdin.transform(utf8.decoder).transform(const LineSplitter());
  await for (final line in lines) {
    stdout.writeln(handleLine(line));
    await stdout.flush();
  }
}
