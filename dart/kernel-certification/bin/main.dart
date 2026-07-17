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

// Command main is a non-functional stub, matching the Go and Python
// certification wrappers: certification conformance runs through the shared
// conformance engine driving the adapter process directly.

import 'dart:io';

import 'package:tuvren_kernel_certification/stub.dart';

void main() {
  stderr.writeln(stubMessage());
  exit(1);
}
