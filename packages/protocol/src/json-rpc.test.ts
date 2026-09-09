/**
 * JSON-RPC 2.0 编解码单测（M1-02 验收锚点：malformed 请求一律 -32600）
 */
import { describe, expect, it } from "vitest";
import {
  decodeRpcMessage,
  decodeRpcMessageText,
  encodeError,
  encodeNotification,
  encodeSuccess,
  isNotification,
} from "./json-rpc.js";
import { ERROR_CODES, RpcError } from "./errors.js";

/** 构造合法请求基准对象（各用例在其上做变体） */
function baseRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "discover",
    params: { query: "document" },
  };
}

describe("decodeRpcMessage：合法消息", () => {
  it("接受完整请求（含 id 与 params）", () => {
    const msg = decodeRpcMessage(baseRequest());
    expect(msg).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "discover",
      params: { query: "document" },
    });
  });

  it("接受无 params 的请求", () => {
    const o = baseRequest();
    delete o["params"];
    const msg = decodeRpcMessage(o);
    expect(msg.params).toBeUndefined();
  });

  it("接受无 id 的 notification（事件推送，5.4）", () => {
    const o = baseRequest();
    delete o["id"];
    const msg = decodeRpcMessage(o);
    expect(msg.id).toBeUndefined();
    expect(isNotification(msg)).toBe(true);
  });

  it("有 id 的请求不是 notification", () => {
    const msg = decodeRpcMessage(baseRequest());
    expect(isNotification(msg)).toBe(false);
  });

  it("接受 string 类型的 id", () => {
    const msg = decodeRpcMessage({ ...baseRequest(), id: "abc" });
    expect(msg.id).toBe("abc");
  });

  it("params 允许空对象", () => {
    const msg = decodeRpcMessage({ ...baseRequest(), params: {} });
    expect(msg.params).toEqual({});
  });
});

describe("decodeRpcMessage：malformed 消息一律 -32600（M1-02 验收锚点）", () => {
  const cases: Array<[string, unknown]> = [
    ["null", null],
    ["原始值字符串", "hello"],
    ["原始值数字", 42],
    ["布尔值", true],
    ["数组（batch 不支持）", [baseRequest()]],
    ["jsonrpc 版本错误", { ...baseRequest(), jsonrpc: "1.0" }],
    [
      "jsonrpc 缺失",
      (() => {
        const o = baseRequest();
        delete o["jsonrpc"];
        return o;
      })(),
    ],
    [
      "method 缺失",
      (() => {
        const o = baseRequest();
        delete o["method"];
        return o;
      })(),
    ],
    ["method 非 string", { ...baseRequest(), method: 123 }],
    ["method 空字符串", { ...baseRequest(), method: "" }],
    ["params 为数组（位置参数不支持）", { ...baseRequest(), params: ["a", "b"] }],
    ["params 为原始值", { ...baseRequest(), params: "document" }],
    ["params 为 null", { ...baseRequest(), params: null }],
    ["id 为布尔", { ...baseRequest(), id: true }],
    ["id 为对象", { ...baseRequest(), id: { x: 1 } }],
    ["id 为 null（保留值不用）", { ...baseRequest(), id: null }],
  ];

  it.each(cases)("%s → RpcError(-32600)", (_name, payload) => {
    // 双重断言：既要是 RpcError 实例，code 又必须精确为 -32600
    expect(() => decodeRpcMessage(payload)).toThrow(RpcError);
    try {
      decodeRpcMessage(payload);
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.INVALID_REQUEST);
    }
  });
});

describe("decodeRpcMessageText：JSON 文本入口", () => {
  it("合法 JSON 文本正常解析", () => {
    const msg = decodeRpcMessageText(
      '{"jsonrpc":"2.0","id":7,"method":"cancel","params":{"invocation_id":"inv_x"}}',
    );
    expect(msg.method).toBe("cancel");
    expect(msg.params).toEqual({ invocation_id: "inv_x" });
  });

  it("非合法 JSON → RpcError(-32600)（协议不使用 -32700，见 json-rpc.ts 文件头）", () => {
    expect(() => decodeRpcMessageText("{oops")).toThrow(RpcError);
    try {
      decodeRpcMessageText("{oops");
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.INVALID_REQUEST);
    }
  });

  it("合法 JSON 但结构非法 → 同样 -32600", () => {
    try {
      decodeRpcMessageText('{"foo":1}');
      expect.unreachable("应当抛出 RpcError");
    } catch (e) {
      expect((e as RpcError).code).toBe(ERROR_CODES.INVALID_REQUEST);
    }
  });
});

describe("编码函数", () => {
  it("encodeSuccess：标准成功响应形状", () => {
    expect(encodeSuccess(1, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });
  });

  it("encodeError：携带 code / message / data", () => {
    const err = new RpcError(ERROR_CODES.INPUT_VALIDATION_FAILED, "输入校验失败", [
      { instancePath: "/content", keyword: "required" },
    ]);
    expect(encodeError(3, err)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: 40002,
        message: "输入校验失败",
        data: [{ instancePath: "/content", keyword: "required" }],
      },
    });
  });

  it("encodeError：无 data 时不输出 data 字段；id 允许 null（malformed 兜底）", () => {
    const err = new RpcError(ERROR_CODES.METHOD_NOT_FOUND);
    expect(encodeError(null, err)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: "方法不存在" },
    });
  });

  it("encodeNotification：无 id，params 可选（5.4 事件推送）", () => {
    expect(encodeNotification("event", { event: "execution.progress" })).toEqual({
      jsonrpc: "2.0",
      method: "event",
      params: { event: "execution.progress" },
    });
    expect(encodeNotification("event")).toEqual({ jsonrpc: "2.0", method: "event" });
  });
});
