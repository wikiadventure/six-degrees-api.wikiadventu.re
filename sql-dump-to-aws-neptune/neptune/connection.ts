import * as fs from 'fs';
import * as path from 'path';
import type { Edge, WikiPage } from '../index.js';

const ROWS_PER_FILE = 1_000_000;
const OUTPUT_DIR = './neptune-csv';

function ensureDirSync(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getCsvStream(prefix: string, fileIndex: number, isNewFile: boolean) {
    ensureDirSync(OUTPUT_DIR);
    const filePath = path.join(OUTPUT_DIR, `${prefix}-${fileIndex}.csv`);
    const stream = fs.createWriteStream(filePath, { flags: isNewFile ? 'w' : 'a' });
    if (isNewFile) {
        if (prefix === 'pages') {
            stream.write('~id,label,id:title,isRedirect\n');
        } else {
            stream.write('~id,~from,~to,label\n');
        }
    }
    return stream;
}

export type CsvWriteState = { fileIndex: number, rowCount: number };

// Global state for CSV writing
export const pageCsvState: CsvWriteState = { fileIndex: 1, rowCount: 0 };
export const linkCsvState: CsvWriteState = { fileIndex: 1, rowCount: 0 };
export const redirectCsvState: CsvWriteState = { fileIndex: 1, rowCount: 0 };

export async function insertPages(
    batch: WikiPage[]
): Promise<void> {
    let { fileIndex, rowCount } = pageCsvState;
    let isNewFile = rowCount === 0;
    const filePrefix = 'pages';
    let stream = getCsvStream(filePrefix, fileIndex, isNewFile);
    for (const page of batch) {
        if (rowCount > 0 && rowCount % ROWS_PER_FILE === 0) {
            stream.end();
            fileIndex++;
            rowCount = 0;
            isNewFile = true;
            stream = getCsvStream(filePrefix, fileIndex, isNewFile);
        }
        stream.write(`${page.id},WikiPage,${page.title.replace(/"/g, '""')},${page.isRedirect}\n`);
        rowCount++;
        isNewFile = false;
    }
    stream.end();
    pageCsvState.fileIndex = fileIndex;
    pageCsvState.rowCount = rowCount;
}

export async function insertLinks(
    batch: Edge[]
): Promise<void> {
    let { fileIndex, rowCount } = linkCsvState;
    let isNewFile = rowCount === 0;
    const filePrefix = 'links';
    let stream = getCsvStream(filePrefix, fileIndex, isNewFile);
    for (let i = 0; i < batch.length; i++) {
        if (rowCount > 0 && rowCount % ROWS_PER_FILE === 0) {
            stream.end();
            fileIndex++;
            rowCount = 0;
            isNewFile = true;
            stream = getCsvStream(filePrefix, fileIndex, isNewFile);
        }
        const edge = batch[i];
        stream.write(`link${fileIndex}_${rowCount + 1},${edge._from},${edge._to},WikiLink\n`);
        rowCount++;
        isNewFile = false;
    }
    stream.end();
    linkCsvState.fileIndex = fileIndex;
    linkCsvState.rowCount = rowCount;
}

export async function insertRedirects(
    batch: Edge[]
): Promise<void> {
    let { fileIndex, rowCount } = redirectCsvState;
    let isNewFile = rowCount === 0;
    const filePrefix = 'redirects';
    let stream = getCsvStream(filePrefix, fileIndex, isNewFile);
    for (let i = 0; i < batch.length; i++) {
        if (rowCount > 0 && rowCount % ROWS_PER_FILE === 0) {
            stream.end();
            fileIndex++;
            rowCount = 0;
            isNewFile = true;
            stream = getCsvStream(filePrefix, fileIndex, isNewFile);
        }
        const edge = batch[i];
        stream.write(`redirect${fileIndex}_${rowCount + 1},${edge._from},${edge._to},WikiRedirect\n`);
        rowCount++;
        isNewFile = false;
    }
    stream.end();
    redirectCsvState.fileIndex = fileIndex;
    redirectCsvState.rowCount = rowCount;
}
