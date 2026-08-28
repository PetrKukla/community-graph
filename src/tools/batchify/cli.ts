/**
 * CLI obálka nad `rawMessagesToBatches`.
 *
 * Vezme syrový export zpráv (JSON pole, jeden JSON objekt, nebo NDJSON — jeden objekt na řádek)
 * ze souboru nebo ze stdinu a rozdělí ho na dávky pro `POST /api/v1/batches`
 * **po serverech → po kanálech → po dnech**.
 *
 * S `--out <dir>` se výsledek zapíše do složkové struktury (složka se vytvoří):
 *
 *   <dir>/<guild>/<channel>/<YYYY-MM-DD>.json
 *
 * Názvy složek `<guild>` / `<channel>` se berou z `--guild-name` / `--channel` (viz --dir-names),
 * kde chybí, použije se ID. Bez `--out` se na stdout vypíše ploché pole všech dávek (náhled).
 *
 * Použití:
 *   bun run convert --guild <GUILD_ID> --out ./batches dump.json
 *   cat dump.json | bun run convert --guild <GUILD_ID> --out ./batches
 *
 * Volby:
 *   --out <dir>            výstupní složka (vytvoří se); bez ní jde ploché pole na stdout
 *   --guild <id>           ID guildy/serveru pro kanály mimo --guild-map
 *   --guild-name <name>    název guildy (do guild.name i do názvu složky)
 *   --guild-map <path>     JSON soubor { "<channel_id>": "<guild_id>" } pro dumpy s víc servery
 *   --channel <id=name>    název kanálu pro dané channel_id (do channel.name i názvu složky)
 *   --dir-names <mode>     name (výchozí) | id | name-id — jak pojmenovat složky
 *   --include-deleted      zahrnout i smazané zprávy (deleted_at != null)
 *   --include-empty        zahrnout i zprávy s prázdným obsahem
 *   --pretty               odsazený JSON i pro stdout náhled (soubory jsou odsazené vždy)
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
    rawMessagesToBatches,
    type ConvertOptions,
    type DirNaming
} from './batchify';

interface ParsedArgs {
    file?: string;
    outDir?: string;
    guildId?: string;
    guildName?: string;
    guildMapPath?: string;
    channels: Record<string, { name?: string; type?: string }>;
    dirNames?: DirNaming;
    includeDeleted: boolean;
    includeEmpty: boolean;
    pretty: boolean;
}

const DIR_NAMING_MODES: readonly DirNaming[] = ['name', 'id', 'name-id'];

const noColor = process.env.NO_COLOR != null;
const paint = (code: string, s: string, tty: boolean): string =>
    !noColor && tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const greenOut = (s: string): string => paint('32', s, process.stdout.isTTY);
const greenErr = (s: string): string => paint('32', s, process.stderr.isTTY);
const redErr = (s: string): string => paint('31', s, process.stderr.isTTY);

function parseArgs(argv: string[]): ParsedArgs {
    const parsed: ParsedArgs = {
        channels: {},
        includeDeleted: false,
        includeEmpty: false,
        pretty: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        switch (arg) {
            case '--out':
            case '-o':
                parsed.outDir = argv[++i];
                break;
            case '--guild':
            case '-g':
                parsed.guildId = argv[++i];
                break;
            case '--guild-name':
                parsed.guildName = argv[++i];
                break;
            case '--guild-map':
                parsed.guildMapPath = argv[++i];
                break;
            case '--channel': {
                const raw = argv[++i] ?? '';
                const eq = raw.indexOf('=');
                if (eq === -1)
                    throw new Error(
                        `--channel čekám tvar id=name, dostal jsem: ${raw}`
                    );
                parsed.channels[raw.slice(0, eq)] = { name: raw.slice(eq + 1) };
                break;
            }
            case '--dir-names': {
                const mode = argv[++i] as DirNaming;
                if (!DIR_NAMING_MODES.includes(mode)) {
                    throw new Error(
                        `--dir-names: čekám ${DIR_NAMING_MODES.join(' | ')}, dostal jsem: ${mode}`
                    );
                }
                parsed.dirNames = mode;
                break;
            }
            case '--include-deleted':
                parsed.includeDeleted = true;
                break;
            case '--include-empty':
                parsed.includeEmpty = true;
                break;
            case '--pretty':
                parsed.pretty = true;
                break;
            case '--help':
            case '-h':
                printHelpAndExit();
                break;
            default:
                if (arg.startsWith('-'))
                    throw new Error(`neznámá volba: ${arg}`);
                if (parsed.file)
                    throw new Error(
                        `čekám jen jeden vstupní soubor, druhý: ${arg}`
                    );
                parsed.file = arg;
        }
    }

    return parsed;
}

function printHelpAndExit(): never {
    console.log(
        [
            'bun run convert --guild <GUILD_ID> --out <dir> [dump.json] [volby]',
            '',
            '  --out <dir>          výstupní složka: <dir>/<guild>/<channel>/<YYYY-MM-DD>.json',
            '                      (bez --out jde ploché pole dávek na stdout)',
            '  --guild <id>         ID guildy/serveru pro kanály mimo --guild-map',
            '  --guild-name <name>  název guildy (do guild.name i do názvu složky)',
            '  --guild-map <path>   JSON { "channel_id": "guild_id" } pro dumpy s víc servery',
            '  --channel <id=name>  název kanálu (do channel.name i názvu složky; lze zopakovat)',
            '  --dir-names <mode>   name (výchozí) | id | name-id — jak pojmenovat složky',
            '  --include-deleted    zahrnout smazané zprávy',
            '  --include-empty      zahrnout zprávy s prázdným obsahem',
            '  --pretty             odsazený JSON i pro stdout náhled'
        ].join('\n')
    );
    process.exit(0);
}

/** Zkusí JSON (pole nebo objekt), jinak spadne na NDJSON (objekt na řádek). */
function parseInput(text: string): unknown {
    const trimmed = text.trim();
    if (trimmed === '') throw new Error('prázdný vstup');

    try {
        const value = JSON.parse(trimmed);
        return Array.isArray(value) ? value : [value];
    } catch {
        // NDJSON fallback
        const rows: unknown[] = [];
        const lines = trimmed.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!.trim();
            if (line === '' || line === '[' || line === ']') continue;
            const clean = line.replace(/,\s*$/, '');
            try {
                rows.push(JSON.parse(clean));
            } catch {
                throw new Error(
                    `řádek ${i + 1} není platný JSON: ${line.slice(0, 80)}`
                );
            }
        }
        return rows;
    }
}

async function loadGuildMap(path: string): Promise<Record<string, string>> {
    const parsed = JSON.parse(await Bun.file(path).text()) as unknown;
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error(
            `--guild-map: čekám JSON objekt { "channel_id": "guild_id" }`
        );
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
        if (typeof v !== 'string' || v.trim() === '') {
            throw new Error(
                `--guild-map: hodnota pro "${k}" musí být neprázdný string`
            );
        }
        out[k] = v;
    }
    return out;
}

async function main() {
    const args = parseArgs(Bun.argv.slice(2));

    const guildMap = args.guildMapPath
        ? await loadGuildMap(args.guildMapPath)
        : undefined;

    if (!args.guildId && !guildMap) {
        console.error(
            redErr(
                'chyba: dodej --guild <GUILD_ID> nebo --guild-map <path> (syrový dump ID serveru neobsahuje)'
            )
        );
        process.exit(1);
    }

    const text = args.file
        ? await Bun.file(args.file).text()
        : await Bun.stdin.text();
    const input = parseInput(text);

    const options: ConvertOptions = {
        guildId: args.guildId,
        guildName: args.guildName,
        guildMap,
        channels: args.channels,
        dirNames: args.dirNames,
        includeDeleted: args.includeDeleted,
        includeEmpty: args.includeEmpty
    };

    const { files, stats } = rawMessagesToBatches(input, options);

    const summary =
        `${stats.fileCount} souborů — ${stats.guildCount} serverů / ${stats.channelCount} kanálů / ` +
        `${stats.dayCount} dnů, ${stats.outputCount} zpráv (vstup ${stats.inputCount}, ` +
        `smazané ${stats.skippedDeleted}, prázdné ${stats.skippedEmpty}, duplicity ${stats.skippedDuplicate})`;

    if (!args.outDir) {
        console.error(
            greenErr(summary + ' — bez --out, ploché pole dávek jde na stdout')
        );
        console.log(
            JSON.stringify(
                files.map((f) => f.batch),
                null,
                args.pretty ? 2 : 0
            )
        );
        return;
    }

    await mkdir(args.outDir, { recursive: true });
    for (const file of files) {
        const fullPath = join(args.outDir, file.relativePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await Bun.write(fullPath, JSON.stringify(file.batch, null, 2) + '\n');
    }

    console.log(greenOut(`zapsáno do ${args.outDir}/ : ${summary}`));
}

main().catch((err) => {
    console.error(
        redErr(`chyba: ${err instanceof Error ? err.message : String(err)}`)
    );
    process.exit(1);
});
