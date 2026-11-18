/* ---------- Filter noise Tier 0 ----------
 * Kandidat memori yang jelas BUKAN memori (output tool, baris shell, kode
 * lepas, narasi agen) ditolak sebelum masuk DB. Diukur dari data nyata: di
 * satu DB pengguna, ~45% draft heuristik berasal dari pola di bawah.
 *
 * Aturan berupa tabel data (id + pola) supaya bisa dites per aturan,
 * dilaporkan sebagai alasan triage, dan diperluas tanpa menyentuh logika.
 * Pola dicocokkan ke konten yang sudah dinormalisasi (spasi tunggal, trim).
 * ------------------------------------------------------------------------- */

export interface NoiseRule {
  id: string;
  test: (s: string) => boolean;
}

const re = (id: string, pattern: RegExp): NoiseRule => ({ id, test: (s) => pattern.test(s) });

export const NOISE_RULES: NoiseRule[] = [
  // Echo/status dari tool agen & build tool
  re("tool-echo", /\b(has been (updated|created|modified|deleted|written) successfully|(file|changes?) (created|written|saved|applied) successfully|successfully (wrote|created|updated|applied|deleted)|applied \d+ edits?|modified \d+ files?)\b/i),
  re("build-log", /^(Compiling|Finished|Running|Downloading|Downloaded|Installing|Installed|Building|Bundling|Resolving|Fetching|Updating|Locking|Checking|Linking|Collecting|Requirement already satisfied|added \d+ packages?|up to date|audited \d+)\b/i),
  re("cli-stream", /^(exit code|stdout|stderr|npm (warn|notice|err!?)|warn(ing)?:|error: command failed|\$ |> |❯ |\[\d+\/\d+\]|\d+%\s|✓ |✔ |✗ |✘ |⠋|⠙|⠹)/i),
  re("stack-frame", /^at\s+[\w$.<>[\]]+\s*\(|^at\s+\/|^File "[^"]+", line \d+/),
  re("injected-tag", /<\/?(ide_[a-z_]+|system-reminder|command-(name|message|args)|local-command-[a-z]+|environment_context|user-prompt-submit-hook)\b/i),
  // Output shell: ls -l, ps, grep -n, listing bernomor (Read tool), du/df
  re("ls-line", /^[dlcbps-][rwxsStT-]{9}[@+.]?\s+\d+\s+\S+/),
  re("ls-total", /^total \d+$/),
  re("ps-line", /^\S+\s+\d+\s+\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+\s+\d+\s/),
  re("grep-line", /^[\w./~@+-]+:\d+(:\d+)?:\s?\S/),
  re("numbered-listing", /^\s*\d+\s*(→|\t|\|)\s?/),
  re("size-line", /^\d+(\.\d+)?[KMGT]i?B?\s+[\w./~-]+$/),
  re("table-row", /^\|.*\|$/),
  re("image-meta", /^Multiply coordinates by [\d.]+ to map to original image/i),
  re("tool-marker", /^\((?:Bash|Tool|Command) (?:completed|ran|finished)[^)]*\)$|^\[(?:command|bash|tool|output|stdout|stderr|result|image|request interrupted)[^\]]*\]/i),
  re("git-output", /^\[[\w./-]+ [0-9a-f]{7,}\]|^(?:On branch|Your branch is|Changes (?:not staged|to be committed)|Untracked files|nothing to commit|Switched to (?:a new )?branch|HEAD is now at)\b|^[0-9a-f]{7,40}\s+\S/),
  re("box-drawing", /^[│├└┌┐┘╰╭╮╯─═║┃┏┗┣▶►→•·]{1,}[\s─═►→]/),
  // Listing file bernomor (output tool Read) yang kehilangan pemisah "→"/tab
  re("numbered-code", /^\d{1,5}:?\s*(?:\/\/|\/\*|\*\/?|#|export\b|import\b|const\b|let\b|var\b|function\b|return\b|class\b|interface\b|type\b|[{}<]|[\w$]+\s+[\w$]+\s*[;=(]|@\w+)/),
  re("code-comment", /^(?:\/\/\/?|\/\*\*?|\*\/?)\s/),
  // Kode lepas tanpa kalimat penjelas
  // Hanya kata kunci yang hampir tak pernah membuka kalimat biasa ("use"/"type"/
  // "return" sengaja tidak dipakai: "Use pnpm (faster)" adalah keputusan nyata).
  re("code-line", /^(import\s+[\w*{]|export\s+(default|const|function|class|interface|type|async|\{|\*)|from\s+[\w.]+\s+import\s|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|def\s+\w+\(|class\s+\w+[\s({:]|interface\s+\w+\s*\{|enum\s+\w+\s*\{|fn\s+\w+\(|func\s+\w+\(|pub\s+(fn|struct|mod)\s|#include\s|require\(|module\.exports)/),
  re("jsx-line", /^<\/?[A-Za-z][\w.:-]*(\s[^>]*)?\/?>\s*$|\bclassName=["{]/),
  re("json-fragment", /^[{["]\s*"?[\w.-]+"?\s*:\s*[^ ]/),
  // Rujukan lepas: URL / path / alamat tanpa konteks
  re("bare-url", /^(?:[-*•]\s*)?(?:[\w .-]{0,20}:\s*)?<?https?:\/\/\S+>?\.?$/i),
  re("bare-path", /^[`'"]?(?:[A-Za-z]:\\|[~.]{0,2}\/)?[\w.@+-]+(?:[/\\][\w.@+-]+)+[/\\]?[`'"]?\.?$|^[`'"]?[\w-]+\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|md|json|ya?ml|toml|sql|css|scss|html|vue|svelte)[`'"]?$/),
  re("hex-address", /^(?:\(\d+\)\s*)?0x[0-9a-fA-F]{8,}/),
  re("bare-command", /^(?:Command:\s*)?(npm|pnpm|yarn|bun|npx|node|git|gh|python3?|pip3?|cargo|go|make|docker|kubectl|curl|ssh|ls|cd|cat|rm|mv|cp|mkdir|grep|sed|awk|find|sleep|echo|tsc|vite|next|uv)\s[^.!?]*$/),
  // Narasi/proses agen (bukan pengetahuan proyek)
  re("agent-narration", /^(let me|let's|now (i'?ll|i will|let me|let's|i need to|we need to)|i'?ll (now |first |start by )?(check|look|run|read|inspect|start|search|open|verify|review|examine|create|update|fix|try)|i'?m going to|next,? (i'?ll|let me)|first,? (i'?ll|let me)|okay,? (let|now|i)|alright,? |great,? (now|let)|perfect,? (now|let)|inspect(ing)? |checking |reading |looking at |searching |mari (saya|kita) |sekarang (saya|aku|kita) |oke,? (saya|aku|sekarang|kita)|baik,? (saya|sekarang)|saya akan (cek|lihat|baca|jalankan|periksa|mulai)|saya tunggu|saya (lanjut|mulai) (ke|dengan|dari)|aku (cek|lihat|baca|tunggu) )/i),
  re("offer-question", /^(mau (saya|aku|ku|gue)|want me to|should i|shall i|do you want|would you like|apakah (kamu|anda|mau)|perlu (saya|aku)|kalau mau|if you want|if you'd like)\b/i),
  re("generic-agent", /\b(how can i help|let me know if|feel free to|hope this helps|happy to help|semoga membantu|ada yang (lain|bisa))\b/i),
];

/** Rasio huruf terhadap karakter non-spasi — teks didominasi angka/simbol
 * (hash, tabel angka, dump) bukan memori yang bisa dibaca manusia. */
export function letterRatio(s: string): number {
  const compact = s.replace(/\s+/g, "");
  if (!compact.length) return 0;
  const letters = (compact.match(/\p{L}/gu) || []).length;
  return letters / compact.length;
}

/** Jumlah kata "nyata" (≥2 huruf, mengandung huruf). */
export function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length;
}

/** Alasan noise (id aturan) atau null bila kandidat layak dinilai. */
export function noiseReason(raw: string): string | null {
  const s = (raw || "").replace(/\s+/g, " ").trim();
  if (s.length < 15) return "too-short";
  for (const r of NOISE_RULES) if (r.test(s)) return r.id;
  if (letterRatio(s) < 0.55) return "symbol-heavy";
  if (wordCount(s) < 3) return "too-few-words";
  return null;
}
