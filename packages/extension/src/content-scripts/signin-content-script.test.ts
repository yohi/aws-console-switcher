// @vitest-environment jsdom
/**
 * サインイン DOM 検知・値注入・認証エラー検知の純粋関数ユニットテスト（task 5.2）。
 *
 * jsdom 環境で実 DOM フィクスチャ（`document.createElement` / `innerHTML`）を組み立て、
 * 検出器・注入器・状態分類・変化監視・メッセージ送受信ヘルパを検証する（items 1-9）。
 * chrome.* ブートストラップ結線（item 10）は薄い未テスト境界のため対象外。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SigninDomEvent } from "@acs/shared";
import { DEFAULT_SELECTOR_SET } from "./selectors.js";
import {
  type PageState,
  type SigninInjectionCommand,
  classifyPageState,
  detectAccountIdField,
  detectAuthErrorMarker,
  detectCaptcha,
  detectCredentialFields,
  detectMfaField,
  detectSubmitButton,
  handleInjectionCommand,
  injectValue,
  observePageState,
  pageStateToDomEvent,
  sendSigninDomEvent,
  submitForm,
} from "./signin-content-script.js";

/** `innerHTML` から ParentNode（コンテナ要素）を組み立てる。 */
function makeContainer(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

const ACCOUNT_HTML = '<input id="account" />';
const CREDENTIAL_HTML = '<input id="username" /><input id="password" />';
const MFA_HTML = '<input id="mfaCode" />';
const AUTH_ERROR_HTML = '<div id="error_message">Authentication failed</div>';
const SUBMIT_HTML = '<button id="signin_button">Sign in</button>';

describe("detectAccountIdField", () => {
  it("returns the account id input when present", () => {
    const doc = makeContainer(ACCOUNT_HTML);
    const el = detectAccountIdField(doc, DEFAULT_SELECTOR_SET);
    expect(el).not.toBeNull();
    expect(el?.id).toBe("account");
  });

  it("returns null when the account id input is absent", () => {
    const doc = makeContainer("<section></section>");
    expect(detectAccountIdField(doc, DEFAULT_SELECTOR_SET)).toBeNull();
  });
});

describe("detectCredentialFields", () => {
  it("returns both username and password when present", () => {
    const doc = makeContainer(CREDENTIAL_HTML);
    const fields = detectCredentialFields(doc, DEFAULT_SELECTOR_SET);
    expect(fields.username?.id).toBe("username");
    expect(fields.password?.id).toBe("password");
  });

  it("returns null password when only username is present", () => {
    const doc = makeContainer('<input id="username" />');
    const fields = detectCredentialFields(doc, DEFAULT_SELECTOR_SET);
    expect(fields.username?.id).toBe("username");
    expect(fields.password).toBeNull();
  });
});

describe("detectMfaField", () => {
  it("returns the mfa input when present", () => {
    const doc = makeContainer(MFA_HTML);
    expect(detectMfaField(doc, DEFAULT_SELECTOR_SET)?.id).toBe("mfaCode");
  });

  it("returns null when the mfa input is absent", () => {
    const doc = makeContainer("<div></div>");
    expect(detectMfaField(doc, DEFAULT_SELECTOR_SET)).toBeNull();
  });
});

describe("detectAuthErrorMarker", () => {
  it("returns the auth error marker when present", () => {
    const doc = makeContainer(AUTH_ERROR_HTML);
    expect(detectAuthErrorMarker(doc, DEFAULT_SELECTOR_SET)?.id).toBe(
      "error_message",
    );
  });

  it("returns null when no auth error marker is present", () => {
    const doc = makeContainer("<div></div>");
    expect(detectAuthErrorMarker(doc, DEFAULT_SELECTOR_SET)).toBeNull();
  });
});

describe("detectSubmitButton", () => {
  it("returns the submit button when present", () => {
    const doc = makeContainer(SUBMIT_HTML);
    expect(detectSubmitButton(doc, DEFAULT_SELECTOR_SET)?.id).toBe(
      "signin_button",
    );
  });

  it("falls back to a generic submit button via ordered fallback", () => {
    const doc = makeContainer('<button type="submit">Go</button>');
    expect(detectSubmitButton(doc, DEFAULT_SELECTOR_SET)).not.toBeNull();
  });
});

describe("injectValue", () => {
  it("sets the value and dispatches an input event on a real input", () => {
    const input = document.createElement("input");
    const listener = vi.fn();
    input.addEventListener("input", listener);
    const ok = injectValue(input, "123456789012");
    expect(ok).toBe(true);
    expect(input.value).toBe("123456789012");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns false for a null element", () => {
    expect(injectValue(null, "x")).toBe(false);
  });

  it("returns false for a non-input element (not settable)", () => {
    const div = document.createElement("div");
    expect(injectValue(div, "x")).toBe(false);
  });
});

describe("submitForm", () => {
  it("clicks the button and returns true", () => {
    const button = document.createElement("button");
    const listener = vi.fn();
    button.addEventListener("click", listener);
    expect(submitForm(button)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns false for a null button", () => {
    expect(submitForm(null)).toBe(false);
  });
});

describe("classifyPageState", () => {
  it("prioritizes authError over every other state", () => {
    const doc = makeContainer(
      AUTH_ERROR_HTML + CREDENTIAL_HTML + MFA_HTML + ACCOUNT_HTML,
    );
    expect(classifyPageState(doc, DEFAULT_SELECTOR_SET)).toBe("authError");
  });

  it("prioritizes mfa over credentials", () => {
    const doc = makeContainer(CREDENTIAL_HTML + MFA_HTML);
    expect(classifyPageState(doc, DEFAULT_SELECTOR_SET)).toBe("mfa");
  });

  it("classifies a cookie-remembered page (credentials, no account id) as credentials", () => {
    const doc = makeContainer(CREDENTIAL_HTML);
    expect(classifyPageState(doc, DEFAULT_SELECTOR_SET)).toBe("credentials");
  });

  it("classifies a generic-entry page (account id field) as accountId", () => {
    const doc = makeContainer(ACCOUNT_HTML);
    expect(classifyPageState(doc, DEFAULT_SELECTOR_SET)).toBe("accountId");
  });

  it("returns credentials only when both username and password exist", () => {
    const doc = makeContainer('<input id="username" />');
    expect(classifyPageState(doc, DEFAULT_SELECTOR_SET)).toBe("unknown");
  });

  it("returns unknown for an unrecognized page", () => {
    const doc = makeContainer("<main><p>hello</p></main>");
    expect(classifyPageState(doc, DEFAULT_SELECTOR_SET)).toBe("unknown");
  });
});

describe("observePageState", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("notifies the initial state synchronously and returns a disconnect fn", () => {
    document.body.innerHTML = CREDENTIAL_HTML;
    const onChange = vi.fn();
    const disconnect = observePageState(document, DEFAULT_SELECTOR_SET, onChange);
    expect(onChange).toHaveBeenCalledWith("credentials");
    expect(typeof disconnect).toBe("function");
    disconnect();
  });

  it("re-classifies on DOM mutations", async () => {
    document.body.innerHTML = "";
    const onChange = vi.fn();
    const disconnect = observePageState(document, DEFAULT_SELECTOR_SET, onChange);
    expect(onChange).toHaveBeenLastCalledWith("unknown");
    document.body.innerHTML = MFA_HTML;
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith("mfa");
    });
    disconnect();
  });

  it("stops notifying after disconnect", async () => {
    document.body.innerHTML = "";
    const onChange = vi.fn();
    const disconnect = observePageState(document, DEFAULT_SELECTOR_SET, onChange);
    disconnect();
    onChange.mockClear();
    document.body.innerHTML = MFA_HTML;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("sendSigninDomEvent", () => {
  it("wraps the event into a signinDomEvent ExtMessage", () => {
    const sendMessage = vi.fn();
    const runtime = { sendMessage } as unknown as Pick<
      typeof chrome.runtime,
      "sendMessage"
    >;
    const event: SigninDomEvent = "mfaScreenShown";
    sendSigninDomEvent(runtime, 42, "uuid-1", event);
    expect(sendMessage).toHaveBeenCalledWith({
      kind: "signinDomEvent",
      tabId: 42,
      uuid: "uuid-1",
      event: "mfaScreenShown",
    });
  });
});

describe("handleInjectionCommand", () => {
  it("injects the account id and submits", () => {
    const doc = makeContainer(ACCOUNT_HTML + SUBMIT_HTML);
    const clicked = vi.fn();
    doc.querySelector("#signin_button")?.addEventListener("click", clicked);
    const command: SigninInjectionCommand = {
      kind: "injectAccountId",
      accountId: "123456789012",
    };
    expect(handleInjectionCommand(doc, DEFAULT_SELECTOR_SET, command)).toBe(true);
    expect((doc.querySelector("#account") as HTMLInputElement).value).toBe(
      "123456789012",
    );
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("injects username and password then submits", () => {
    const doc = makeContainer(CREDENTIAL_HTML + SUBMIT_HTML);
    const clicked = vi.fn();
    doc.querySelector("#signin_button")?.addEventListener("click", clicked);
    const command: SigninInjectionCommand = {
      kind: "injectCredentials",
      username: "iam-user",
      password: "s3cret",
    };
    expect(handleInjectionCommand(doc, DEFAULT_SELECTOR_SET, command)).toBe(true);
    expect((doc.querySelector("#username") as HTMLInputElement).value).toBe(
      "iam-user",
    );
    expect((doc.querySelector("#password") as HTMLInputElement).value).toBe(
      "s3cret",
    );
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("injects the totp code and submits", () => {
    const doc = makeContainer(MFA_HTML + SUBMIT_HTML);
    const command: SigninInjectionCommand = {
      kind: "injectTotp",
      code: "000111",
    };
    expect(handleInjectionCommand(doc, DEFAULT_SELECTOR_SET, command)).toBe(true);
    expect((doc.querySelector("#mfaCode") as HTMLInputElement).value).toBe(
      "000111",
    );
  });

  it("returns false when the target field is missing", () => {
    const doc = makeContainer(SUBMIT_HTML);
    const command: SigninInjectionCommand = {
      kind: "injectAccountId",
      accountId: "123456789012",
    };
    expect(handleInjectionCommand(doc, DEFAULT_SELECTOR_SET, command)).toBe(
      false,
    );
  });
});

describe("detectCaptcha", () => {
  it("detects a data-captcha marker", () => {
    const doc = makeContainer("<div data-captcha></div>");
    expect(detectCaptcha(doc)).toBe(true);
  });

  it("detects a captcha iframe by src", () => {
    const doc = makeContainer(
      '<iframe src="https://example.com/captcha/frame"></iframe>',
    );
    expect(detectCaptcha(doc)).toBe(true);
  });

  it("returns false on a clean page", () => {
    const doc = makeContainer(CREDENTIAL_HTML);
    expect(detectCaptcha(doc)).toBe(false);
  });
});

describe("pageStateToDomEvent", () => {
  it("maps each recognized page state to its signin DOM event", () => {
    const cases: readonly [PageState, SigninDomEvent][] = [
      ["accountId", "accountIdFieldShown"],
      ["credentials", "credentialFieldShown"],
      ["mfa", "mfaScreenShown"],
      ["authError", "authError"],
    ];
    for (const [state, event] of cases) {
      expect(pageStateToDomEvent(state)).toBe(event);
    }
  });

  it("maps unknown to null (no event emitted)", () => {
    expect(pageStateToDomEvent("unknown")).toBeNull();
  });
});
