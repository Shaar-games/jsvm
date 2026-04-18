import type { Node, Program } from "acorn";

export type AcornNode = Node;
export type AcornProgram = Program;

export type BytecodeInstruction = Array<string | number | null>;

export interface BytecodeBuffer {
  length: number;
  array: BytecodeInstruction[];
  push(line: BytecodeInstruction): void;
  join(separator: string): string;
  program?: unknown;
}
