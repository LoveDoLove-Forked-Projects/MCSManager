import { $t } from "../i18n";
import Router from "@koa/router";
import send from "koa-send";
import fs from "fs-extra";
import path from "path";
import { missionPassport } from "../service/mission_passport";
import InstanceSubsystem from "../service/system_instance";
import FileManager from "../service/system_file";
import formidable from "formidable";
import { clearUploadFiles } from "../tools/filepath";
import logger from "../service/log";

const router = new Router();

// Define the HTTP home page display route
router.all("/", async (ctx) => {
  ctx.body = "[MCSManager Daemon] Status: OK | reference: https://mcsmanager.com/";
  ctx.status = 200;
});

// file download route
router.get("/download/:key/:fileName", async (ctx) => {
  const key = ctx.params.key;
  const paramsFileName = ctx.params.fileName;
  try {
    // Get the task from the task center
    const mission = missionPassport.getMission(key, "download");
    if (!mission) throw new Error((ctx.body = "Access denied: No task found"));
    const instance = InstanceSubsystem.getInstance(mission.parameter.instanceUuid);
    if (!instance) throw new Error($t("TXT_CODE_http_router.instanceNotExist"));
    if (!FileManager.checkFileName(paramsFileName))
      throw new Error($t("TXT_CODE_http_router.fileNameNotSpec"));

    const cwd = instance.absoluteCwdPath();
    const fileRelativePath = mission.parameter.fileName;

    // Check for file cross-directory security risks
    const fileManager = new FileManager(cwd);
    if (!fileManager.check(fileRelativePath))
      throw new Error((ctx.body = "Access denied: Invalid destination"));

    // send File
    const fileAbsPath = fileManager.toAbsolutePath(fileRelativePath);
    const fileDir = path.dirname(fileAbsPath);
    const fileName = path.basename(fileAbsPath);
    ctx.set("Content-Type", "application/octet-stream");
    await send(ctx, fileName, { root: fileDir + "/", hidden: true });
  } catch (error: any) {
    ctx.body = $t("TXT_CODE_http_router.downloadErr", { error: error.message });
    ctx.status = 500;
  } finally {
    missionPassport.deleteMission(key);
  }
});

// File upload route
router.post("/upload/:key", async (ctx) => {
  const key = String(ctx.params.key);
  const unzip = Boolean(ctx.query.unzip);
  const zipCode = String(ctx.query.code);
  let tmpFiles: formidable.File | formidable.File[] | undefined;
  try {
    const mission = missionPassport.getMission(key, "upload");
    if (!mission) throw new Error("Access denied: No task found");
    const instance = InstanceSubsystem.getInstance(mission.parameter.instanceUuid);
    if (!instance) throw new Error("Access denied: No instance found");
    const uploadDir = mission.parameter.uploadDir;
    const cwd = instance.absoluteCwdPath();
    const tmpFiles = ctx.request.files?.file;
    if (tmpFiles) {
      let uploadedFile: formidable.File;
      if (tmpFiles instanceof Array) {
        uploadedFile = tmpFiles[0];
      } else {
        throw new Error("Access denied: Files must a array!");
      }

      const originFileName = uploadedFile.originalFilename || "";
      if (!FileManager.checkFileName(path.basename(originFileName)))
        throw new Error("Access denied: Malformed file name");
      const fileManager = new FileManager(cwd);

      const ext = path.extname(originFileName);
      const basename = path.basename(originFileName, ext);

      let tempFileSaveName = basename + ext;
      let counter = 1;

      while (
        fs.existsSync(
          fileManager.toAbsolutePath(path.normalize(path.join(uploadDir, tempFileSaveName)))
        ) &&
        ctx.query.overwrite === "false"
      ) {
        if (counter == 1) {
          tempFileSaveName = `${basename}-copy${ext}`;
        } else {
          tempFileSaveName = `${basename}-copy-${counter}${ext}`;
        }
        counter++;
      }

      let fileSaveRelativePath = path.normalize(path.join(uploadDir, tempFileSaveName));

      if (!fileManager.checkPath(fileSaveRelativePath))
        throw new Error("Access denied: Invalid destination");

      const fileSaveAbsolutePath = fileManager.toAbsolutePath(fileSaveRelativePath);

      logger.info(
        "Browser Upload File:",
        fileSaveAbsolutePath,
        "File size:",
        Number(uploadedFile.size / 1024 / 1024).toFixed(0),
        "MB"
      );

      await fs.move(uploadedFile.filepath, fileSaveAbsolutePath, {
        overwrite: true
      });

      if (unzip) {
        const instanceFiles = new FileManager(instance.absoluteCwdPath());
        instanceFiles.unzip(fileSaveAbsolutePath, path.dirname(fileSaveAbsolutePath), zipCode);
      }
      ctx.body = "OK";
      return;
    }
    ctx.body = "Access denied: No file found";
    ctx.status = 500;
  } catch (error: any) {
    ctx.body = error.message;
    ctx.status = 500;
  } finally {
    missionPassport.deleteMission(key);
    if (tmpFiles) clearUploadFiles(tmpFiles);
  }
});
export default router;
