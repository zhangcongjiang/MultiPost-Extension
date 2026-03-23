import type { FileData, SyncData, VideoData } from "../common";

export async function VideoDouyin(data: SyncData) {
  /**
   * Format date to yyyy-MM-dd HH:mm format
   * @param date - Date object to format
   * @returns Formatted date string
   */
  function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

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

  // ===== 新增工具函数 =====
  function moveCursorToEnd(el: HTMLElement) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function pasteText(el: HTMLElement, text: string) {
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });

    event.clipboardData!.setData("text/plain", text);
    el.dispatchEvent(event);
  }

  function insertEnter(el: HTMLElement) {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
    });
    el.dispatchEvent(event);
  }

  async function uploadVideo(file: File): Promise<void> {
    const fileInput = (await waitForElement("input[type=file]")) as HTMLInputElement;

    // 创建一个新的 File 对象，因为某些浏览器可能不允许直接设置 fileInput.files
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;

    // 触发 change 事件
    const changeEvent = new Event("change", { bubbles: true });
    fileInput.dispatchEvent(changeEvent);

    // 触发 input 事件
    const inputEvent = new Event("input", { bubbles: true });
    fileInput.dispatchEvent(inputEvent);

    console.log("视频上传事件已触发");
  }

  async function uploadCover(cover: FileData, verticalCover: FileData): Promise<void> {
    console.log("尝试上传封面", cover);
    const coverUploadContainer = await waitForElement("div.content-upload-new");
    console.log("封面上传容器", coverUploadContainer);
    if (!coverUploadContainer) return;

    const coverUploadButton = coverUploadContainer.firstChild?.firstChild?.firstChild as HTMLElement;
    console.log("封面上传按钮", coverUploadButton);
    if (!coverUploadButton) return;

    coverUploadButton.click();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const fileInput = (await waitForElement('input[type="file"].semi-upload-hidden-input')) as HTMLInputElement;
    console.log("封面文件输入框", fileInput);
    if (!fileInput) return;

    if (!cover.type?.includes("image/")) {
      console.log("提供的封面文件不是图片类型", cover);
      return;
    }

    const response = await fetch(cover.url);
    const arrayBuffer = await response.arrayBuffer();
    const imageFile = new File([arrayBuffer], cover.name, { type: cover.type });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(imageFile);
    fileInput.files = dataTransfer.files;

    const changeEvent = new Event("change", { bubbles: true });
    fileInput.dispatchEvent(changeEvent);

    const inputEvent = new Event("input", { bubbles: true });
    fileInput.dispatchEvent(inputEvent);

    console.log("竖版封面文件上传操作已触发");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const verticalButtons = document.querySelectorAll("button.semi-button.semi-button-primary.semi-button-light");
    console.log("完成按钮列表", verticalButtons);
    const verticalButton = Array.from(verticalButtons).find((button) => button.textContent === "设置横封面");
    console.log("设置横版封面按钮", verticalButton);
    if (verticalButton) {
      (verticalButton as HTMLElement).click();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const uploadBlocks = Array.from(document.querySelectorAll("div.container-XzaV9h"));

    const horizontalBlock = uploadBlocks.find((el) => el.textContent?.includes("上传封面"));

    if (!horizontalBlock) {
      console.log("没找到横版上传区域");
      return;
    }

    const verticalFileInput = horizontalBlock.querySelector(
      'input[type="file"].semi-upload-hidden-input',
    ) as HTMLInputElement;

    console.log("横版真实 input:", verticalFileInput);

    if (!verticalFileInput) return;

    // === 构造文件 ===
    const verticalResponse = await fetch(verticalCover.url);
    const verticalArrayBuffer = await verticalResponse.arrayBuffer();
    const verticalImageFile = new File([verticalArrayBuffer], verticalCover.name, { type: verticalCover.type });

    const dt = new DataTransfer();
    dt.items.add(verticalImageFile);

    verticalFileInput.files = dt.files;

    // 🔥 关键触发链
    verticalFileInput.dispatchEvent(new Event("input", { bubbles: true }));
    verticalFileInput.dispatchEvent(new Event("change", { bubbles: true }));
    verticalFileInput.click();

    console.log("横版封面上传触发完成");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const doneButtons = document.querySelectorAll("button.semi-button.semi-button-primary.semi-button-light");
    console.log("完成按钮列表", doneButtons);
    const doneButton = Array.from(doneButtons).find((button) => button.textContent === "完成");
    console.log("完成", doneButton);
    if (doneButton) {
      (doneButton as HTMLElement).click();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  try {
    const { content, video, title, tags, cover, verticalCover, scheduledPublishTime } = data.data as VideoData;
    // 处理视频上传
    if (video) {
      const response = await fetch(video.url);
      const blob = await response.blob();
      const videoFile = new File([blob], video.name, { type: video.type });
      console.log(`视频文件: ${videoFile.name} ${videoFile.type} ${videoFile.size}`);

      await uploadVideo(videoFile);
      console.log("视频上传已初始化");
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 处理标题输入
    const titleInput = (await waitForElement('input[placeholder*="作品标题"]')) as HTMLInputElement;
    if (titleInput) {
      titleInput.value = title || content.slice(0, 20);
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      console.log("标题已填写:", titleInput.value);
    }

    // 填写内容和标签
    const contentEditor = (await waitForElement(
      'div.zone-container.editor-kit-container.editor.editor-comp-publish[contenteditable="true"]',
    )) as HTMLDivElement;

    if (contentEditor) {
      // ===== 写内容 =====
      moveCursorToEnd(contentEditor);

      pasteText(contentEditor, `${content}\n`);

      // 等待编辑器稳定（很关键）
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // ===== 写标签 =====
      if (tags && tags.length > 0) {
        const tagsToSync = tags.slice(0, 5);

        for (const tag of tagsToSync) {
          console.log("添加标签:", tag);

          // ⚠️ 每次都重新锁光标（关键）
          moveCursorToEnd(contentEditor);

          pasteText(contentEditor, `#${tag}`);
          // 停顿 0.5 秒
          await new Promise((resolve) => setTimeout(resolve, 200));

          // 插入换行（你要的 enter）
          insertEnter(contentEditor);
        }
      }
    }

    // 处理封面上传
    if (cover) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await uploadCover(cover, verticalCover);
    }

    // 处理定时发布
    if (scheduledPublishTime) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const labels = document.querySelectorAll("label");
      console.log("labels -->", labels);
      const scheduledLabel = Array.from(labels).find((label) => label.textContent?.includes("定时发布"));
      console.log("scheduledLabel -->", scheduledLabel);
      if (scheduledLabel) {
        (scheduledLabel as HTMLElement).click();
        await new Promise((resolve) => setTimeout(resolve, 500));

        const publishTimeInput = document.querySelector('input[format="yyyy-MM-dd HH:mm"]') as HTMLInputElement;
        console.log("publishTimeInput -->", publishTimeInput);
        if (publishTimeInput) {
          publishTimeInput.value = formatDate(new Date(scheduledPublishTime));
          publishTimeInput.dispatchEvent(new Event("input", { bubbles: true }));
          publishTimeInput.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("定时发布时间已设置:", publishTimeInput.value);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      // 处理自动发布
      const buttons = document.querySelectorAll("button");
      const publishButton = Array.from(buttons).find((button) => button.textContent === "发布");

      if (publishButton) {
        console.log("点击发布按钮");
        publishButton.click();
      } else {
        console.log('未找到"发布"按钮');
      }
    }
  } catch (error) {
    console.error("DouyinVideo 发布过程中出错:", error);
  }
}
