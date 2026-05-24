/**
 * Copyright 2026 Oscar Yáñez Cisterna (@SkrOYC)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { InputSignal, TuvrenToolDefinition } from "@tuvren/runtime";

const CALCULATOR_OPERATIONS = [
  "add",
  "subtract",
  "multiply",
  "divide",
  "power",
  "average",
  "min",
  "max",
] as const;
const WEATHER_CONDITIONS = [
  "sunny",
  "partly cloudy",
  "overcast",
  "windy",
  "light rain",
  "clear",
] as const;

type CalculatorOperation = (typeof CALCULATOR_OPERATIONS)[number];
type WeatherUnit = "celsius" | "fahrenheit";

export function createReplBuiltinTools(): TuvrenToolDefinition[] {
  return [
    {
      description: "Search deterministic REPL documents",
      execute(input) {
        const query =
          typeof input === "object" &&
          input !== null &&
          "query" in input &&
          typeof input.query === "string"
            ? input.query
            : "unknown";
        return {
          hits: [
            {
              title: "Tuvren Runtime",
              url: "https://example.invalid/tuvren",
            },
          ],
          query,
        };
      },
      inputSchema: {
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        type: "object",
      },
      name: "search",
    },
    {
      approval: true,
      description: "Send a deterministic REPL email",
      execute(input) {
        const to =
          typeof input === "object" &&
          input !== null &&
          "to" in input &&
          typeof input.to === "string"
            ? input.to
            : "unknown@example.invalid";
        return {
          sent: true,
          to,
        };
      },
      inputSchema: {
        properties: {
          subject: { type: "string" },
          to: { type: "string" },
        },
        required: ["to", "subject"],
        type: "object",
      },
      name: "email",
    },
    {
      description:
        "Perform deterministic arithmetic on one or more numeric operands.",
      execute(input) {
        const operation = readCalculatorOperation(input);
        const operands = readNumberArray(input, "operands");

        if (operation === undefined || operands === undefined) {
          return {
            message:
              "calculator requires an operation and a numeric operands array.",
            status: "error",
          };
        }

        return evaluateCalculator(operation, operands);
      },
      inputSchema: {
        properties: {
          operands: {
            items: { type: "number" },
            minItems: 1,
            type: "array",
          },
          operation: {
            enum: [...CALCULATOR_OPERATIONS],
            type: "string",
          },
        },
        required: ["operation", "operands"],
        type: "object",
      },
      name: "calculator",
    },
    {
      description:
        "Get deterministic mock weather for a location without calling an external API.",
      execute(input) {
        const location = readTrimmedString(input, "location");

        if (location === undefined) {
          return {
            message: "weather requires a non-empty location string.",
            status: "error",
          };
        }

        const requestedUnit = readTrimmedString(input, "unit");
        const unit: WeatherUnit =
          requestedUnit === "fahrenheit" ? "fahrenheit" : "celsius";
        const seed = createDeterministicSeed(location.toLowerCase());
        const condition = WEATHER_CONDITIONS[seed % WEATHER_CONDITIONS.length];
        const temperatureCelsius = -2 + (seed % 35);
        const feelsLikeCelsius =
          temperatureCelsius + ((Math.floor(seed / 3) % 5) - 2);
        const humidityPercent = 35 + (seed % 61);
        const windSpeedKph = 5 + (Math.floor(seed / 7) % 36);
        const temperature = roundWeatherValue(
          convertTemperature(temperatureCelsius, unit)
        );
        const feelsLike = roundWeatherValue(
          convertTemperature(feelsLikeCelsius, unit)
        );

        return {
          condition,
          feelsLike,
          humidityPercent,
          location,
          source: "mock",
          summary: `${condition} in ${location}`,
          temperature,
          unit,
          windSpeedKph,
        };
      },
      inputSchema: {
        properties: {
          location: { type: "string" },
          unit: {
            enum: ["celsius", "fahrenheit"],
            type: "string",
          },
        },
        required: ["location"],
        type: "object",
      },
      name: "weather",
    },
  ];
}

export function textSignal(text: string): InputSignal {
  return {
    parts: [
      {
        text,
        type: "text",
      },
    ],
  };
}

function readCalculatorOperation(
  input: unknown
): CalculatorOperation | undefined {
  const operation = readTrimmedString(input, "operation");

  if (operation === undefined || !isCalculatorOperation(operation)) {
    return undefined;
  }

  return operation;
}

function readNumberArray(
  input: unknown,
  propertyName: string
): number[] | undefined {
  if (!(isRecord(input) && propertyName in input)) {
    return undefined;
  }

  const value = input[propertyName];

  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "number")
  ) {
    return undefined;
  }

  return [...value];
}

function readTrimmedString(
  input: unknown,
  propertyName: string
): string | undefined {
  if (!(isRecord(input) && propertyName in input)) {
    return undefined;
  }

  const value = input[propertyName];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCalculatorOperation(value: string): value is CalculatorOperation {
  return CALCULATOR_OPERATIONS.some((operation) => operation === value);
}

function evaluateCalculator(
  operation: CalculatorOperation,
  operands: number[]
):
  | {
      operation: CalculatorOperation;
      operands: number[];
      result: number;
      status: "success";
    }
  | {
      message: string;
      operation: CalculatorOperation;
      operands: number[];
      status: "error";
    } {
  switch (operation) {
    case "add":
      return createCalculatorSuccess(
        operation,
        operands,
        operands.reduce((sum, operand) => sum + operand, 0)
      );
    case "subtract":
      return createCalculatorSuccess(
        operation,
        operands,
        operands
          .slice(1)
          .reduce((result, operand) => result - operand, operands[0])
      );
    case "multiply":
      return createCalculatorSuccess(
        operation,
        operands,
        operands.reduce((product, operand) => product * operand, 1)
      );
    case "divide": {
      const [, ...divisors] = operands;

      if (divisors.length === 0) {
        return createCalculatorError(
          operation,
          operands,
          "divide requires at least two operands."
        );
      }

      if (divisors.some((operand) => operand === 0)) {
        return createCalculatorError(
          operation,
          operands,
          "division by zero is not allowed."
        );
      }

      return createCalculatorSuccess(
        operation,
        operands,
        divisors.reduce((result, operand) => result / operand, operands[0])
      );
    }
    case "power":
      if (operands.length !== 2) {
        return createCalculatorError(
          operation,
          operands,
          "power requires exactly two operands."
        );
      }

      return createCalculatorSuccess(
        operation,
        operands,
        operands[0] ** operands[1]
      );
    case "average":
      return createCalculatorSuccess(
        operation,
        operands,
        operands.reduce((sum, operand) => sum + operand, 0) / operands.length
      );
    case "min":
      return createCalculatorSuccess(
        operation,
        operands,
        Math.min(...operands)
      );
    case "max":
      return createCalculatorSuccess(
        operation,
        operands,
        Math.max(...operands)
      );
    default:
      return createCalculatorError(
        operation,
        operands,
        `unsupported calculator operation "${operation}".`
      );
  }
}

function createCalculatorSuccess(
  operation: CalculatorOperation,
  operands: number[],
  result: number
) {
  return {
    operation,
    operands,
    result,
    status: "success" as const,
  };
}

function createCalculatorError(
  operation: CalculatorOperation,
  operands: number[],
  message: string
) {
  return {
    message,
    operation,
    operands,
    status: "error" as const,
  };
}

function createDeterministicSeed(value: string): number {
  let seed = 0;

  for (const [index, character] of Array.from(value).entries()) {
    const codePoint = character.codePointAt(0);

    if (codePoint === undefined) {
      continue;
    }

    seed += codePoint * (index + 1);
  }

  return seed;
}

function convertTemperature(valueCelsius: number, unit: WeatherUnit): number {
  if (unit === "fahrenheit") {
    return valueCelsius * (9 / 5) + 32;
  }

  return valueCelsius;
}

function roundWeatherValue(value: number): number {
  return Math.round(value * 10) / 10;
}
