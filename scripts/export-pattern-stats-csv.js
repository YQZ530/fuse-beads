const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function readArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printUsageAndExit() {
  console.log('Usage: node scripts/export-pattern-stats-csv.js --pattern <file.grid.json> [--out <stats.csv>]');
  process.exit(1);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function compareColorKeys(a, b) {
  const parsedA = parseColorKey(a);
  const parsedB = parseColorKey(b);
  if (parsedA.prefix !== parsedB.prefix) {
    return parsedA.prefix.localeCompare(parsedB.prefix, 'en');
  }
  if (parsedA.number !== parsedB.number) {
    return parsedA.number - parsedB.number;
  }
  return a.localeCompare(b, 'en', { numeric: true });
}

function parseColorKey(colorKey) {
  const match = /^([A-Za-z]+)\s*0*(\d+)/.exec(String(colorKey));
  return {
    prefix: match?.[1]?.toUpperCase() ?? String(colorKey).toUpperCase(),
    number: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER,
  };
}

function normalizePath(filePath) {
  if (!filePath) return '';
  return path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function defaultOutputPath(patternPath) {
  const baseName = path.basename(patternPath, '.grid.json');
  return path.join(rootDir, 'results', 'exports', `${baseName}.colors.csv`);
}

function readPatternStats(patternPath) {
  const pattern = readJson(patternPath);
  if (!pattern.colorCounts || typeof pattern.colorCounts !== 'object') {
    throw new Error(`Missing colorCounts in ${patternPath}`);
  }

  return Object.entries(pattern.colorCounts)
    .map(([hex, entry]) => ({
      hex: String(entry.color || hex).toUpperCase(),
      brand: pattern.brand || pattern.selectedColorSystem || 'MARD',
      paletteName: pattern.paletteName || '',
      colorKey: entry.colorKey || entry.key || '',
      count: Number(entry.count || 0),
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => compareColorKeys(a.colorKey, b.colorKey));
}

function main() {
  const patternPath = normalizePath(readArg('--pattern'));
  if (!patternPath) {
    printUsageAndExit();
  }
  if (!fs.existsSync(patternPath)) {
    throw new Error(`Pattern file not found: ${patternPath}`);
  }

  const outputPath = normalizePath(readArg('--out')) || defaultOutputPath(patternPath);
  const rows = readPatternStats(patternPath);
  const csv = [
    ['hex', 'brand', 'paletteName', 'color_key', 'count'].join(','),
    ...rows.map((row) => [
      row.hex,
      row.brand,
      row.paletteName,
      row.colorKey,
      row.count,
    ].map(csvEscape).join(',')),
  ].join('\n');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${csv}\n`, 'utf8');
  console.log(`Wrote ${path.relative(rootDir, outputPath).replace(/\\/g, '/')}`);
  console.log(`${rows.length} colors exported`);
}

main();
