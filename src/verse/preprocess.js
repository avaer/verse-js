// preprocess.js
// Verse uses significant indentation. The Peggy grammar expects explicit
// `end` terminators, so this pass inserts them based on indentation.
// Vendorized from johanfortus/Verse-Online-Editor (MIT), extended to also
// produce a line map from preprocessed line numbers back to original line
// numbers (used for breakpoints, stepping, and error locations).

export function injectEndsWithMap(sourceCode) {
    const lines = sourceCode.replace(/\r\n?/g, '\n').split('\n');
    const indentStack = [0];
    const outputLines = [];
    // lineMap[i] = 1-based original line number for preprocessed line i+1.
    // Inserted `end` lines map to the original line they close after.
    const lineMap = [];
    let braceBlockDepth = 0;
    let pendingBraceHeader = false;
    let lastOriginalLine = 1;

    function stripLineComment(line) {
        return line.replace(/#.*$/, '');
    }

    function isBraceBlockHeader(trimmedLine) {
        return (
            /^if\b/.test(trimmedLine) ||
            /^for\b/.test(trimmedLine) ||
            /^loop\b/.test(trimmedLine) ||
            /^else\b/.test(trimmedLine) ||
            /^[A-Za-z_][A-Za-z0-9_]*\s*:=\s*class\b/.test(trimmedLine) ||
            /^[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\n]+>)*\s*\(.*\)\s*(?:<[^>\n]+>\s*)*:\s*[A-Za-z_[]][A-Za-z0-9_[]]*\s*=$/.test(trimmedLine)
        );
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const raw = lines[lineIndex];
        const originalLine = lineIndex + 1;
        const codePortion = stripLineComment(raw);
        const indentWidth = (/^[ \t]*/.exec(raw)[0]).length;
        const trimmed = codePortion.trim();
        const isBlankLine = trimmed === '';
        const continuesConditional = /^(else|then)\b/.test(trimmed);
        const opensBraceBlock = trimmed === '{'
            ? pendingBraceHeader
            : trimmed.endsWith('{') && isBraceBlockHeader(trimmed.slice(0, -1).trim());
        const closesBraceBlock = trimmed === '}';

        if (!isBlankLine && braceBlockDepth === 0) {
            while (
                indentWidth < indentStack[indentStack.length - 1] &&
                !continuesConditional
            ) {
                indentStack.pop();
                outputLines.push('end');
                lineMap.push(lastOriginalLine);
            }
            if (indentWidth > indentStack[indentStack.length - 1]) {
                indentStack.push(indentWidth);
            }
        }
        outputLines.push(raw);
        lineMap.push(originalLine);

        if (!isBlankLine) {
            lastOriginalLine = originalLine;
        }

        if (opensBraceBlock) {
            braceBlockDepth += 1;
            pendingBraceHeader = false;
            continue;
        }

        if (closesBraceBlock && braceBlockDepth > 0) {
            braceBlockDepth -= 1;
            pendingBraceHeader = false;
            continue;
        }

        if (!isBlankLine) {
            pendingBraceHeader = isBraceBlockHeader(trimmed);
        }
    }

    while (indentStack.length > 1) {
        indentStack.pop();
        outputLines.push('end');
        lineMap.push(lastOriginalLine);
    }

    return {
        code: outputLines.join('\n'),
        lineMap,
    };
}

export function injectEnds(sourceCode) {
    return injectEndsWithMap(sourceCode).code;
}

// Maps a 1-based line number in the preprocessed source back to the
// corresponding 1-based line number in the original source.
export function mapToOriginalLine(lineMap, preprocessedLine) {
    if (!lineMap || preprocessedLine < 1) {
        return preprocessedLine;
    }

    if (preprocessedLine > lineMap.length) {
        return lineMap[lineMap.length - 1] ?? preprocessedLine;
    }

    return lineMap[preprocessedLine - 1];
}
