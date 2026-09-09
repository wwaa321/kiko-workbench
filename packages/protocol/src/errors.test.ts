/**
 * 错误码表与 RpcError 单测（M1-02）
 * 错误码数值与设计文档 5.5 一一对应，全量断言防止误改。
 */
import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_MESSAGES, RpcError } from "./errors.js";

describe("错误码表（设计文档 5.5，勿改动数值）", () => {
  it("全量 16 个错误码与文档一致", () => {
    expect(ERROR_CODES).toEqual({
      AUTH_FAILED: -32001,
      INVALID_REQUEST: -32600,
      METHOD_NOT_FOUND: -32601,
      INVALID_PARAMS: -32602,
      INTERNAL_ERROR: -32603,
      CAPABILITY_NOT_FOUND: 40001,
      INPUT_VALIDATION_FAILED: 40002,
      INVOCATION_NOT_FOUND: 40003,
      ILLEGAL_STATE_OPERATION: 40004,
      PLUGIN_UNAVAILABLE: 40005,
      EXECUTION_TIMEOUT: 40006,
      EXECUTION_CANCELLED: 40007,
      PLUGIN_ID_CONFLICT: 40008,
      BUILTIN_PLUGIN_PROTECTED: 40009,
      PLUGIN_UI_NOT_OPEN: 40010,
      PLUGIN_EXECUTION_ERROR: 50001,
    });
  });

  it("每个错误码都有非空默认消息", () => {
    for (const code of Object.values(ERROR_CODES)) {
      const message = ERROR_MESSAGES[code];
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe("RpcError", () => {
  it("携带 code / message / data，且是 Error 子类", () => {
    const err = new RpcError(ERROR_CODES.CAPABILITY_NOT_FOUND, "能力不存在", {
      capability_id: "x",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RpcError");
    expect(err.code).toBe(40001);
    expect(err.message).toBe("能力不存在");
    expect(err.data).toEqual({ capability_id: "x" });
  });

  it("message 缺省取错误码默认消息", () => {
    expect(new RpcError(ERROR_CODES.PLUGIN_UNAVAILABLE).message).toBe("插件不可用");
  });

  it("data 缺省为 undefined", () => {
    expect(new RpcError(ERROR_CODES.EXECUTION_TIMEOUT, "执行超时").data).toBeUndefined();
  });
});
