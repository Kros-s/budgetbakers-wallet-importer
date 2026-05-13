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
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));

  try {
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

    const stem = path.basename(audioPath, path.extname(audioPath));
    return fs.readFileSync(path.join(outDir, `${stem}.txt`), "utf8").trim();
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
