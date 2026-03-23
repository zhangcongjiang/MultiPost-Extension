import type { DynamicData, SyncData } from "../common";

export async function DynamicBaijiahao(data: SyncData) {
  function waitForElement(selector: string, timeout = 10000): Promise<Element> {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(`元素未找到: ${selector}`);
      }, timeout);
    });
  }

  // ✅ 输入内容（适配 Lexical 编辑器）
  async function inputContent(text: string) {
    const editor = (await waitForElement('div[contenteditable="true"][data-lexical-editor="true"]')) as HTMLElement;

    editor.focus();

    // 🔥 关键：模拟 Ctrl + A（全选）
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        code: "KeyA",
        ctrlKey: true,
        bubbles: true,
      }),
    );

    editor.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "a",
        code: "KeyA",
        ctrlKey: true,
        bubbles: true,
      }),
    );

    await new Promise((r) => setTimeout(r, 30));

    // 🔥 删除（Delete 比 Backspace 更稳）
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        code: "Delete",
        keyCode: 46,
        bubbles: true,
      }),
    );

    editor.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Delete",
        code: "Delete",
        keyCode: 46,
        bubbles: true,
      }),
    );

    await new Promise((r) => setTimeout(r, 50));

    // ===== 输入内容 =====
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      document.execCommand("insertText", false, lines[i]);

      if (i < lines.length - 1) {
        ["keydown", "keypress", "keyup"].forEach((type) => {
          editor.dispatchEvent(
            new KeyboardEvent(type, {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
            }),
          );
        });

        await new Promise((r) => setTimeout(r, 30));
      }
    }

    console.debug("内容输入完成（已彻底清空）");
  }

  // ✅ 上传图片（新版页面专用）
  async function uploadImages(images: any[]) {
    if (!images?.length) return;

    // 1️⃣ 打开弹窗
    const uploadBtn = (await waitForElement("._971503697980b5f9-wrap")) as HTMLElement;
    uploadBtn.click();

    await waitForElement(".cheetah-modal-content");

    // 2️⃣ 获取 input
    const fileInput = (await waitForElement('.cheetah-modal-content input[type="file"]')) as HTMLInputElement;

    console.debug("找到 input");

    // 🔥 关键：用原生 setter
    const dt = new DataTransfer();

    for (const image of images) {
      try {
        const res = await fetch(image.url);
        const blob = await res.blob();
        const file = new File([blob], image.name, { type: blob.type });

        dt.items.add(file);
      } catch (e) {
        console.error(e);
      }
    }

    const files = dt.files;

    // 🔥 核心：调用原生 setter（不是 defineProperty）
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")!.set;

    nativeSetter!.call(fileInput, files);

    // 🔥 再触发 change（这次会被识别）
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    console.debug("已注入 files");

    // ===== 等上传完成 =====
    let confirmBtn: HTMLButtonElement | null = null;

    for (let i = 0; i < 20; i++) {
      confirmBtn = document.querySelector(".cheetah-modal-footer button.cheetah-btn-primary") as HTMLButtonElement;

      if (confirmBtn && !confirmBtn.disabled) break;

      await new Promise((r) => setTimeout(r, 1000));
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));

    if (confirmBtn && !confirmBtn.disabled) {
      confirmBtn.click();
      console.debug("点击确认");
    } else {
      console.error("上传失败（确认按钮未激活）");
    }
  }

  try {
    const { content, images, title } = data.data as DynamicData;

    const combinedContent = title ? `${title}\n\n${content || ""}` : content || "";

    // ===== 1️⃣ 输入内容 =====
    await inputContent(combinedContent);

    await new Promise((r) => setTimeout(r, 2000));

    // ===== 2️⃣ 上传图片 =====
    await uploadImages(images);

    // ===== 3️⃣ 点击发布 =====
    await new Promise((r) => setTimeout(r, 2000));

    const buttons = Array.from(document.querySelectorAll("button"));
    const publishButton = buttons.find((btn) => btn.textContent?.trim() === "发布") as HTMLButtonElement;

    if (publishButton) {
      if (data.isAutoPublish) {
        console.debug("点击发布");
        publishButton.click();
      }
    } else {
      console.error("未找到发布按钮");
    }
  } catch (e) {
    console.error("发布失败:", e);
  }
}
