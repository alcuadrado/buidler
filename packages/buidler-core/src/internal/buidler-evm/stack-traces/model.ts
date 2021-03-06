import { bufferToHex } from "ethereumjs-util";

import { Opcode } from "./opcodes";

// tslint:disable only-buidler-error

export enum JumpType {
  NOT_JUMP,
  INTO_FUNCTION,
  OUTOF_FUNCTION,
  INTERNAL_JUMP
}

export enum ContractType {
  CONTRACT,
  LIBRARY
}

export enum ContractFunctionType {
  CONSTRUCTOR,
  FUNCTION,
  FALLBACK,
  GETTER,
  MODIFIER
}

export enum ContractFunctionVisibility {
  PRIVATE,
  INTERNAL,
  PUBLIC,
  EXTERNAL
}

export class SourceFile {
  public readonly contracts: Contract[] = [];
  public readonly functions: ContractFunction[] = [];

  constructor(
    public readonly globalName: string,
    public readonly content: string
  ) {}

  public addContract(contract: Contract) {
    if (contract.location.file !== this) {
      throw new Error("Trying to add a contract from another file");
    }

    this.contracts.push(contract);
  }

  public addFunction(func: ContractFunction) {
    if (func.location.file !== this) {
      throw new Error("Trying to add a function from another file");
    }

    this.functions.push(func);
  }

  public getContainingFunction(
    location: SourceLocation
  ): ContractFunction | undefined {
    // TODO: Optimize this with a binary search or an internal tree

    for (const func of this.functions) {
      if (func.location.contains(location)) {
        return func;
      }
    }

    return undefined;
  }
}

export class SourceLocation {
  private _line: number | undefined;

  constructor(
    public readonly file: SourceFile,
    public readonly offset: number,
    public readonly length: number
  ) {}

  public getStartingLineNumber(): number {
    if (this._line === undefined) {
      this._line = 1;

      for (const c of this.file.content.slice(0, this.offset)) {
        if (c === "\n") {
          this._line += 1;
        }
      }
    }

    return this._line;
  }

  public getContainingFunction(): ContractFunction | undefined {
    return this.file.getContainingFunction(this);
  }

  public contains(other: SourceLocation) {
    if (this.file !== other.file) {
      return false;
    }

    if (other.offset < this.offset) {
      return false;
    }

    return other.offset + other.length <= this.offset + this.length;
  }

  public equals(other: SourceLocation) {
    return (
      this.file === other.file &&
      this.offset === other.offset &&
      this.length === other.length
    );
  }
}

export class Contract {
  public readonly localFunctions: ContractFunction[] = [];

  private _constructor: ContractFunction | undefined;
  private _fallback: ContractFunction | undefined;
  private readonly _selectorHexToFunction: Map<
    string,
    ContractFunction
  > = new Map();

  constructor(
    public readonly name: string,
    public readonly type: ContractType,
    public readonly location: SourceLocation
  ) {}

  get constructorFunction(): ContractFunction | undefined {
    return this._constructor;
  }

  get fallback(): ContractFunction | undefined {
    return this._fallback;
  }

  public addLocalFunction(func: ContractFunction) {
    if (func.contract !== this) {
      throw new Error("Function isn't local");
    }

    if (
      func.visibility === ContractFunctionVisibility.PUBLIC ||
      func.visibility === ContractFunctionVisibility.EXTERNAL
    ) {
      if (
        func.type === ContractFunctionType.FUNCTION ||
        func.type === ContractFunctionType.GETTER
      ) {
        this._selectorHexToFunction.set(bufferToHex(func.selector!), func);
      } else if (func.type === ContractFunctionType.CONSTRUCTOR) {
        this._constructor = func;
      } else if (func.type === ContractFunctionType.FALLBACK) {
        this._fallback = func;
      }
    }

    this.localFunctions.push(func);
  }

  public addNextLinearizedBaseContract(baseContract: Contract) {
    if (this._fallback === undefined && baseContract._fallback !== undefined) {
      this._fallback = baseContract._fallback;
    }

    for (const baseContractFunction of baseContract.localFunctions) {
      if (
        baseContractFunction.type !== ContractFunctionType.GETTER &&
        baseContractFunction.type !== ContractFunctionType.FUNCTION
      ) {
        continue;
      }

      if (
        baseContractFunction.visibility !== ContractFunctionVisibility.PUBLIC &&
        baseContractFunction.visibility !== ContractFunctionVisibility.EXTERNAL
      ) {
        continue;
      }

      const selectorHex = bufferToHex(baseContractFunction.selector!);
      if (!this._selectorHexToFunction.has(selectorHex)) {
        this._selectorHexToFunction.set(selectorHex, baseContractFunction);
      }
    }
  }

  public getFunctionFromSelector(
    selector: Buffer
  ): ContractFunction | undefined {
    return this._selectorHexToFunction.get(bufferToHex(selector));
  }

  /**
   * We compute selectors manually, which is particularly hard. We do this
   * because we need to map selectors to AST nodes, and it seems easier to start
   * from the AST node. This is surprisingly super hard: things like inherited
   * enums, structs and ABIv2 complicate it.
   *
   * As we know that that can fail, we run a heuristic that tries to correct
   * incorrect selectors. What it does is checking the `evm.methodIdentifiers`
   * compiler output, and detect missing selectors. Then we take those and
   * find contract functions with the same name. If there are multiple of those
   * we can't do anything. If there is a single one, it must have an incorrect
   * selector, so we update it with the `evm.methodIdentifiers`'s value.
   */
  public correctSelector(functionName: string, selector: Buffer): boolean {
    const functions = Array.from(this._selectorHexToFunction.values()).filter(
      cf => cf.name === functionName
    );

    if (functions.length !== 1) {
      return false;
    }

    const functionToCorrect = functions[0];

    if (functionToCorrect.selector !== undefined) {
      this._selectorHexToFunction.delete(
        bufferToHex(functionToCorrect.selector)
      );
    }

    functionToCorrect.selector = selector;
    this._selectorHexToFunction.set(bufferToHex(selector), functionToCorrect);
    return true;
  }
}

export class ContractFunction {
  constructor(
    public readonly name: string,
    public readonly type: ContractFunctionType,
    public readonly location: SourceLocation,
    public readonly contract: Contract,
    public readonly visibility?: ContractFunctionVisibility,
    public readonly isPayable?: boolean,
    public selector?: Buffer
  ) {
    if (!contract.location.contains(location)) {
      throw new Error("Incompatible contract and function location");
    }
  }
}

export class Instruction {
  constructor(
    public readonly pc: number,
    public readonly opcode: Opcode,
    public readonly jumpType: JumpType,
    public readonly pushData?: Buffer,
    public readonly location?: SourceLocation
  ) {}
}

export class Bytecode {
  private readonly _pcToInstruction: Map<number, Instruction> = new Map();

  constructor(
    public readonly contract: Contract,
    public readonly isDeployment: boolean,
    public readonly normalizedCode: Buffer,
    public readonly instructions: Instruction[],
    public readonly libraryAddressPositions: number[],
    public readonly compilerVersion: string
  ) {
    for (const inst of instructions) {
      this._pcToInstruction.set(inst.pc, inst);
    }
  }

  public getInstruction(pc: number): Instruction {
    const inst = this._pcToInstruction.get(pc);

    if (inst === undefined) {
      throw new Error(`There's no instruction at pc ${pc}`);
    }

    return inst;
  }
}
