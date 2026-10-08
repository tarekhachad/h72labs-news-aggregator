// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PasswordInput } from "@/components/PasswordInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(ui: React.ReactElement) {
  act(() => root.render(ui));
  const input = container.querySelector("input")!;
  const button = container.querySelector("button")!;
  return { input, button };
}

describe("PasswordInput", () => {
  it("starts hidden, with a button named for what it will do", () => {
    const { input, button } = mount(<PasswordInput name="password" />);
    expect(input.type).toBe("password");
    expect(button.getAttribute("aria-label")).toBe("Show password");
    expect(button.textContent).toBe("Show");
    expect(button.getAttribute("aria-controls")).toBe(input.id);
  });

  it("shows and hides the password on click", () => {
    const { input, button } = mount(<PasswordInput name="password" />);
    act(() => button.click());
    expect(input.type).toBe("text");
    expect(button.getAttribute("aria-label")).toBe("Hide password");
    expect(button.textContent).toBe("Hide");
    act(() => button.click());
    expect(input.type).toBe("password");
    expect(button.getAttribute("aria-label")).toBe("Show password");
  });

  it("keeps what was typed across a toggle", () => {
    const { input, button } = mount(<PasswordInput name="password" />);
    input.value = "hunter22";
    act(() => button.click());
    expect(input.value).toBe("hunter22");
  });

  it("never submits its form", () => {
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    const { button } = mount(
      <form>
        <PasswordInput name="password" />
      </form>
    );
    container.querySelector("form")!.addEventListener("submit", onSubmit);
    expect(button.type).toBe("button");
    act(() => button.click());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("is reachable by keyboard: a real button, not taken out of the tab order", () => {
    const { button } = mount(<PasswordInput name="password" />);
    expect(button.tagName).toBe("BUTTON");
    expect(button.hasAttribute("tabindex")).toBe(false);
    expect(button.disabled).toBe(false);
  });

  it("goes back to dots when the form is sent", () => {
    const { input, button } = mount(
      <form onSubmit={(e) => e.preventDefault()}>
        <PasswordInput name="password" />
      </form>
    );
    act(() => button.click());
    expect(input.type).toBe("text");
    act(() => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(input.type).toBe("password");
  });

  it("passes name, autoComplete, required, minLength and placeholder through untouched", () => {
    const { input } = mount(
      <PasswordInput name="newPassword" autoComplete="new-password" required minLength={6} placeholder="New password" />
    );
    expect(input.name).toBe("newPassword");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(input.required).toBe(true);
    expect(input.minLength).toBe(6);
    expect(input.placeholder).toBe("New password");
  });

  it("adds no autoComplete, required or minLength the caller didn't ask for", () => {
    const { input } = mount(<PasswordInput name="password" />);
    expect(input.hasAttribute("autocomplete")).toBe(false);
    expect(input.required).toBe(false);
    expect(input.hasAttribute("minlength")).toBe(false);
  });

  it("keeps autoComplete while the password is shown", () => {
    const { input, button } = mount(<PasswordInput name="currentPassword" autoComplete="current-password" />);
    act(() => button.click());
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    expect(input.name).toBe("currentPassword");
  });

  it("shows the rule under a new-password field from the start, tied to the input", () => {
    mount(<PasswordInput name="password" showRule />);
    const rule = container.querySelector("p")!;
    expect(rule.textContent).toBe("At least 6 characters");
    expect(container.querySelector("input")!.getAttribute("aria-describedby")).toBe(rule.id);
  });

  it("shows no rule otherwise", () => {
    mount(<PasswordInput name="password" />);
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("input")!.hasAttribute("aria-describedby")).toBe(false);
  });

  it("gives each field its own ids, so two on one page don't collide", () => {
    act(() =>
      root.render(
        <>
          <PasswordInput name="a" showRule />
          <PasswordInput name="b" showRule />
        </>
      )
    );
    const [a, b] = Array.from(container.querySelectorAll("input"));
    expect(a.id).not.toBe(b.id);
    expect(a.getAttribute("aria-describedby")).not.toBe(b.getAttribute("aria-describedby"));
  });
});
