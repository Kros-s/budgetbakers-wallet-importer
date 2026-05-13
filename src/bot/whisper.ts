import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

export async function transcribeAudio(
  audioPath: string,
  opts: { whisperBin?: string; model?: string } = {}
): Promise<string> {
  const bin = opts.whisperBin ?? "whisper";
  const model = opts.model ?? "base";
  const outDir = os.tmpdir();

  await execFileAsync(
    bin,
    [
      audioPath,
      "--model", model,
      "--output_format", "txt",
      "--output_dir", outDir,
      "--language", "es",
      "--fp16", "False",
    ],
    { timeout: 120_000 }
  );

  const basename = path.basename(audioPath, path.extname(audioPath));
  const txtPath = path.join(outDir, `${basename}.txt`);
  const transcript = fs.readFileSync(txtPath, "utf8").trim();
  try { fs.unlinkSync(txtPath); } catch { /* ignore */ }

  return transcript;
}
