import type { SyncData, VideoData } from "../common";

export async function VideoBaijiahao(data: SyncData) {
  function waitForElement(selector: string, timeout = 10000): Promise<Element> {
    return new Promise((resolve, reject) => {
      const element = document.querySelector(selector);
      if (element) {
        resolve(element);
        return;
      }

      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          resolve(element);
          observer.disconnect();
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element with selector "${selector}" not found within ${timeout}ms`));
      }, timeout);
    });
  }

  async function uploadVideo(file: File): Promise<void> {
    const fileInput = (await waitForElement('input[type="file"]')) as HTMLInputElement;
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;

    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    console.log("视频上传触发完成");
  }

  async function waitForUploadCompletion(timeout = 600000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        const publishBtn = document.querySelector("button.cheetah-btn-primary") as HTMLButtonElement;

        if (publishBtn && !publishBtn.disabled) {
          clearInterval(interval);
          console.log("视频上传完成");
          resolve();
        }
      }, 1000);

      setTimeout(() => {
        clearInterval(interval);
        reject(new Error("视频上传超时"));
      }, timeout);
    });
  }

  // ===== 通用上传函数 =====
  async function uploadToInput(input: HTMLInputElement, fileData: any) {
    const res = await fetch(fileData.url);
    const buffer = await res.arrayBuffer();

    const file = new File([buffer], fileData.name, {
      type: fileData.type,
    });

    const dt = new DataTransfer();
    dt.items.add(file);

    input.files = dt.files;

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    console.log("封面上传触发:", file.name);

    // 🔥 关键修复：先等弹窗“真的出现”
    await new Promise((r) => setTimeout(r, 1000));

    // 🔥 再去找按钮（而不是立刻找）
    try {
      await waitAndClickButtonMulti(["确定", "完成"], 10000);
    } catch (_e) {
      console.log("未检测到裁剪弹窗");
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  async function waitAndClickButtonMulti(texts: string[], timeout = 10000) {
    return new Promise<void>((resolve, reject) => {
      const interval = setInterval(() => {
        const buttons = document.querySelectorAll("button");

        const btn = Array.from(buttons).find((b) => {
          const el = b as HTMLButtonElement;
          const text = el.textContent?.trim();

          // 🔥 核心修复：只点“可见”的按钮
          const isVisible =
            el.offsetParent !== null && // 在页面上
            window.getComputedStyle(el).visibility !== "hidden" &&
            window.getComputedStyle(el).display !== "none";

          return text && texts.includes(text) && !el.disabled && isVisible;
        }) as HTMLButtonElement;

        if (btn) {
          clearInterval(interval);
          console.log("点击按钮(真实):", btn.textContent);
          btn.click();
          resolve();
        }
      }, 300);

      setTimeout(() => {
        clearInterval(interval);
        reject(new Error("按钮未找到"));
      }, timeout);
    });
  }

  // ===== 核心：上传双封面 =====
  async function uploadBothCovers(cover?: any, verticalCover?: any) {
    await new Promise((r) => setTimeout(r, 1000));

    const inputs = document.querySelectorAll('input[name="media"]') as NodeListOf<HTMLInputElement>;

    if (inputs.length < 2) {
      console.log("未找到两个封面 input");
      return;
    }

    const [coverInput, verticalInput] = inputs;

    console.log("竖版 input:", coverInput);
    console.log("横版 input:", verticalInput);

    if (cover?.type?.includes("image/")) {
      await uploadToInput(coverInput, cover);
    }
    await new Promise((r) => setTimeout(r, 1500));

    if (verticalCover?.type?.includes("image/")) {
      await uploadToInput(verticalInput, verticalCover);
    }

    console.log("封面上传完成（双封面）");
  }

  try {
    const { content, video, title, tags, cover, verticalCover } = data.data as VideoData;

    if (!video) {
      console.error("没有视频文件");
      return;
    }

    // ===== 上传视频 =====
    const response = await fetch(video.url);
    const arrayBuffer = await response.arrayBuffer();
    const videoFile = new File([arrayBuffer], `${title || "video"}.${video.name.split(".").pop()}`, {
      type: video.type,
    });

    console.log(`准备上传视频: ${videoFile.name}`);

    await uploadVideo(videoFile);
    await waitForUploadCompletion();

    await new Promise((r) => setTimeout(r, 2000));

    // ===== 封面（关键改造点）=====
    if (cover || verticalCover) {
      await uploadBothCovers(cover, verticalCover);
    }

    await new Promise((r) => setTimeout(r, 2500));

    // ===== 发布 =====
    if (data.isAutoPublish) {
      const publishButton =
        (document.querySelector('button[data-testid="publish-btn"]') as HTMLButtonElement | null) ||
        (Array.from(document.querySelectorAll("button")).find(
          (button) =>
            button.textContent?.trim() === "发布" &&
            (button as HTMLButtonElement).disabled === false &&
            (button as HTMLButtonElement).offsetParent !== null,
        ) as HTMLButtonElement | undefined);

      if (publishButton) {
        console.log("点击发布");
        publishButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } else {
        console.log("未找到发布按钮");
      }
    }
  } catch (error) {
    console.error("百家号发布失败:", error);
    throw error;
  }
}
