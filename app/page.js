"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const DEFAULT_MAX_TOTAL_CHARS = 1000;
const STEAM_MAX_LINE_WIDTH = 68;
const STEAM_NEWLINE_COST = 2;
const BRAILLE_BLANK = "\u2800";
const BRAILLE_FULL = "\u28FF";
const BRAILLE_BASE = 0x2800;

const BRAILLE_DOTS = [
  { dx: 0, dy: 0, bit: 1 },
  { dx: 0, dy: 1, bit: 2 },
  { dx: 0, dy: 2, bit: 4 },
  { dx: 1, dy: 0, bit: 8 },
  { dx: 1, dy: 1, bit: 16 },
  { dx: 1, dy: 2, bit: 32 },
  { dx: 0, dy: 3, bit: 64 },
  { dx: 1, dy: 3, bit: 128 }
];

const EMPTY_CELL_OPTIONS = [
  { value: "brailleBlank", label: "Invisible braille (recommande)" },
  { value: "space", label: "Espace classique" }
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeMaxLines(lineWidth, maxChars, newlineCost) {
  if (lineWidth <= 0) {
    return 1;
  }

  return Math.max(1, Math.floor((maxChars + newlineCost) / (lineWidth + newlineCost)));
}

function computeBudgetLength(text, newlineCost) {
  if (!text) {
    return 0;
  }

  let total = 0;
  for (const char of text) {
    total += char === "\n" ? newlineCost : 1;
  }
  return total;
}

function computeBestGridSize(
  naturalWidth,
  naturalHeight,
  requestedWidth,
  maxChars,
  newlineCost
) {
  const maxWidth = clamp(requestedWidth, 1, STEAM_MAX_LINE_WIDTH);
  const safeNaturalWidth = Math.max(1, naturalWidth);
  const safeNaturalHeight = Math.max(1, naturalHeight);
  const sourceRatio = safeNaturalWidth / safeNaturalHeight;

  for (let width = maxWidth; width >= 1; width -= 1) {
    const estimatedLines = Math.max(
      1,
      Math.round(width / (2 * sourceRatio))
    );
    const estimatedChars = width * estimatedLines + newlineCost * (estimatedLines - 1);

    if (estimatedChars <= maxChars) {
      return { width, lines: estimatedLines };
    }
  }

  return { width: 1, lines: 1 };
}

function trimToBudget(text, budget, newlineCost) {
  if (computeBudgetLength(text, newlineCost) <= budget) {
    return text;
  }

  let output = "";
  let used = 0;
  for (const char of text) {
    const cost = char === "\n" ? newlineCost : 1;
    if (used + cost > budget) {
      break;
    }
    output += char;
    used += cost;
  }

  if (output.length < text.length && text[output.length] && text[output.length] !== "\n") {
    const lastBreak = output.lastIndexOf("\n");
    return lastBreak === -1 ? output : output.slice(0, lastBreak);
  }

  return output;
}

function protectLeadingAsciiSpaces(text, replacementChar) {
  const safeChar = replacementChar || BRAILLE_FULL;

  return text
    .split("\n")
    .map((line) => {
      const leadingSpaces = line.match(/^ +/)?.[0].length || 0;
      if (leadingSpaces <= 1) {
        return line;
      }

      const rest = line.slice(leadingSpaces);
      return ` ${safeChar.repeat(leadingSpaces - 1)}${rest}`;
    })
    .join("\n");
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Impossible de lire cette image."));
    };

    image.src = url;
  });
}

function drawContain(context, image, targetWidth, targetHeight) {
  const sourceWidth = image.naturalWidth;
  const sourceHeight = image.naturalHeight;
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = (targetWidth - drawWidth) / 2;
  const offsetY = (targetHeight - drawHeight) / 2;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(image, 0, 0, sourceWidth, sourceHeight, offsetX, offsetY, drawWidth, drawHeight);
}

function resolveEmptyCellChar(mode) {
  return mode === "space" ? " " : BRAILLE_BLANK;
}

async function convertImageToBraille(file, options) {
  const {
    lineWidth,
    maxChars,
    contrast,
    threshold,
    invertBinary,
    emptyCellMode,
    steamProtectAsciiSpaces
  } = options;

  const image = await loadImageFromFile(file);
  const grid = computeBestGridSize(
    image.naturalWidth,
    image.naturalHeight,
    lineWidth,
    maxChars,
    STEAM_NEWLINE_COST
  );
  const charWidth = grid.width;
  const lineCount = grid.lines;
  const pixelWidth = charWidth * 2;
  const pixelHeight = lineCount * 4;

  const canvas = document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Contexte canvas indisponible.");
  }

  context.imageSmoothingEnabled = true;
  drawContain(context, image, pixelWidth, pixelHeight);
  const { data } = context.getImageData(0, 0, pixelWidth, pixelHeight);

  const contrast255 = contrast * 2.55;
  const contrastFactor =
    (259 * (contrast255 + 255)) / (255 * (259 - contrast255));

  const binary = new Uint8Array(pixelWidth * pixelHeight);
  for (let y = 0; y < pixelHeight; y += 1) {
    for (let x = 0; x < pixelWidth; x += 1) {
      const offset = (y * pixelWidth + x) * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const alpha = data[offset + 3];

      if (alpha < 16) {
        binary[y * pixelWidth + x] = invertBinary ? 1 : 0;
        continue;
      }

      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const contrasted = clamp(
        contrastFactor * (luminance - 128) + 128,
        0,
        255
      );
      const blackPixel = contrasted < threshold ? 1 : 0;
      binary[y * pixelWidth + x] = invertBinary ? 1 - blackPixel : blackPixel;
    }
  }

  const emptyCellChar = resolveEmptyCellChar(emptyCellMode);
  const rows = [];

  for (let row = 0; row < lineCount; row += 1) {
    const y = row * 4;
    let line = "";

    for (let col = 0; col < charWidth; col += 1) {
      const x = col * 2;
      let mask = 0;

      for (const dot of BRAILLE_DOTS) {
        const px = x + dot.dx;
        const py = y + dot.dy;
        if (binary[py * pixelWidth + px]) {
          mask |= dot.bit;
        }
      }

      if (mask === 0) {
        line += emptyCellChar;
      } else {
        line += String.fromCodePoint(BRAILLE_BASE + mask);
      }
    }

    rows.push(line);
  }

  let output = rows.join("\n");
  if (emptyCellMode === "space" && steamProtectAsciiSpaces) {
    output = protectLeadingAsciiSpaces(output, BRAILLE_FULL);
  }
  output = trimToBudget(output, maxChars, STEAM_NEWLINE_COST);

  return {
    ascii: output,
    usedWidth: charWidth,
    usedLines: lineCount,
    usedChars: computeBudgetLength(output, STEAM_NEWLINE_COST)
  };
}

export default function HomePage() {
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState("Aucune image");
  const [previewUrl, setPreviewUrl] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const [lineWidth, setLineWidth] = useState(56);
  const [maxChars, setMaxChars] = useState(DEFAULT_MAX_TOTAL_CHARS);
  const [contrast, setContrast] = useState(22);
  const [threshold, setThreshold] = useState(118);
  const [invertBinary, setInvertBinary] = useState(true);
  const [emptyCellMode, setEmptyCellMode] = useState("brailleBlank");
  const [steamProtectAsciiSpaces, setSteamProtectAsciiSpaces] = useState(true);

  const [ascii, setAscii] = useState("");
  const [usedWidth, setUsedWidth] = useState(0);
  const [usedLines, setUsedLines] = useState(0);
  const [usedChars, setUsedChars] = useState(0);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  const maxLines = useMemo(
    () => computeMaxLines(lineWidth, maxChars, STEAM_NEWLINE_COST),
    [lineWidth, maxChars]
  );
  const lineCount = useMemo(() => (ascii ? ascii.split("\n").length : 0), [ascii]);

  const setImageFile = useCallback((nextFile, fallbackName) => {
    if (!nextFile || !nextFile.type.startsWith("image/")) {
      setError("Fichier image invalide.");
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(nextFile);
    setPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return nextPreviewUrl;
    });

    setFile(nextFile);
    setFileName(nextFile.name || fallbackName || "image");
    setAscii("");
    setUsedWidth(0);
    setUsedLines(0);
    setUsedChars(0);
    setError("");
    setCopyStatus("");
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    const onPaste = (event) => {
      const items = event.clipboardData?.items;
      if (!items) {
        return;
      }

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const pastedFile = item.getAsFile();
          if (!pastedFile) {
            return;
          }

          event.preventDefault();
          setImageFile(pastedFile, "image-collee.png");
          return;
        }
      }
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [setImageFile]);

  const onGenerate = async () => {
    if (!file) {
      setError("Ajoute, colle, ou depose une image.");
      return;
    }

    setIsLoading(true);
    setError("");
    setCopyStatus("");

    try {
      const result = await convertImageToBraille(file, {
        lineWidth,
        maxChars,
        contrast,
        threshold,
        invertBinary,
        emptyCellMode,
        steamProtectAsciiSpaces
      });

      if (!result?.ascii) {
        setError("Aucun resultat genere. Essaie une autre image.");
      }

      setAscii(result.ascii);
      setUsedWidth(result.usedWidth);
      setUsedLines(result.usedLines);
      setUsedChars(result.usedChars);
    } catch (generationError) {
      setAscii("");
      setUsedWidth(0);
      setUsedLines(0);
      setUsedChars(0);
      setError(generationError.message || "Erreur pendant la generation.");
    } finally {
      setIsLoading(false);
    }
  };

  const onCopy = async () => {
    if (!ascii) {
      return;
    }

    try {
      await navigator.clipboard.writeText(ascii.replace(/\n/g, "\r\n"));
      setCopyStatus("Copie.");
    } catch {
      setCopyStatus("Copie impossible depuis ce navigateur.");
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    const droppedFile = event.dataTransfer.files?.[0];
    if (droppedFile) {
      setImageFile(droppedFile, "image-deposee");
    }
  };

  return (
    <main className="page">
      <section className="panel">
        <h1>ASCII Steam Generator (Braille)</h1>
        <p>
          Mode braille 2x4 comme ton script Python, compatible Steam:
          {" "}
          <strong>{maxChars} chars max</strong>
          {" "}
          et
          {" "}
          <strong>{STEAM_MAX_LINE_WIDTH} chars max par ligne</strong>.
        </p>

        <div
          className={`dropzone ${isDragging ? "is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          <strong>Glisse-depose une image ici</strong>
          <span>ou clique pour choisir un fichier</span>
          <span>Ctrl+V colle aussi une image</span>
          <input
            id="image-upload"
            type="file"
            accept="image/*"
            onChange={(event) =>
              setImageFile(event.target.files?.[0], "image-selectionnee")
            }
          />
        </div>

        <div className="hint">
          Image actuelle:
          {" "}
          <strong>{fileName}</strong>
        </div>

        {previewUrl ? (
          <img className="preview" src={previewUrl} alt="Apercu source" />
        ) : null}

        <div className="controls">
          <label htmlFor="max-chars" className="label">
            Limite max caracteres Steam: {maxChars}
          </label>
          <input
            id="max-chars"
            type="range"
            min="200"
            max="2000"
            step="10"
            value={maxChars}
            onChange={(event) => setMaxChars(Number(event.target.value))}
          />

          <label htmlFor="line-width" className="label">
            Largeur (caracteres): {lineWidth}
          </label>
          <input
            id="line-width"
            type="range"
            min="20"
            max={STEAM_MAX_LINE_WIDTH}
            value={lineWidth}
            onChange={(event) => setLineWidth(Number(event.target.value))}
          />

          <label htmlFor="contrast" className="label">
            Contraste: {contrast}
          </label>
          <input
            id="contrast"
            type="range"
            min="-80"
            max="80"
            value={contrast}
            onChange={(event) => setContrast(Number(event.target.value))}
          />

          <label htmlFor="threshold" className="label">
            Seuil binaire: {threshold}
          </label>
          <input
            id="threshold"
            type="range"
            min="0"
            max="255"
            value={threshold}
            onChange={(event) => setThreshold(Number(event.target.value))}
          />

          <label className="label checkbox-row" htmlFor="invert-binary">
            <input
              id="invert-binary"
              type="checkbox"
              checked={invertBinary}
              onChange={(event) => setInvertBinary(event.target.checked)}
            />
            Inverser noir/blanc (dessin en vide)
          </label>

          <label htmlFor="empty-cell-mode" className="label">
            Pixel vide
          </label>
          <select
            id="empty-cell-mode"
            value={emptyCellMode}
            onChange={(event) => setEmptyCellMode(event.target.value)}
          >
            {EMPTY_CELL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label
            className="label checkbox-row"
            htmlFor="steam-safe-leading-spaces"
          >
            <input
              id="steam-safe-leading-spaces"
              type="checkbox"
              checked={steamProtectAsciiSpaces}
              onChange={(event) =>
                setSteamProtectAsciiSpaces(event.target.checked)
              }
              disabled={emptyCellMode !== "space"}
            />
            Protection espaces debut de ligne (mode espace)
          </label>
        </div>

        <div className="hint">
          Max lignes possibles avec cette largeur:
          {" "}
          <strong>{maxLines}</strong>
        </div>
        {usedWidth > 0 ? (
          <div className="hint">
            Auto-fit applique:
            {" "}
            <strong>{usedWidth} x {usedLines}</strong>
            {" "}
            caracteres (pour tenir dans {maxChars}).
          </div>
        ) : null}

        <button type="button" onClick={onGenerate} disabled={isLoading}>
          {isLoading ? "Generation..." : "Generer ASCII"}
        </button>

        {error ? <p className="error">{error}</p> : null}

        <div className="stats">
          <span>
            Compteur Steam:
            {" "}
            {usedChars}/{maxChars}
          </span>
          <span>
            Lignes:
            {" "}
            {lineCount}
          </span>
          <span>
            Brut JS:
            {" "}
            {ascii.length}
          </span>
        </div>

        <textarea
          value={ascii}
          readOnly
          rows={16}
          placeholder="Le rendu braille apparaitra ici."
        />

        <div className="actions">
          <button type="button" onClick={onCopy} disabled={!ascii}>
            Copier
          </button>
          {copyStatus ? <span>{copyStatus}</span> : null}
        </div>
      </section>
    </main>
  );
}
