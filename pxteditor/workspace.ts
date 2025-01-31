/// <reference path="../built/pxtlib.d.ts"/>

namespace pxt.workspace {
    export type ScriptText = pxt.Map<string>;

    export interface Project {
        header?: Header;
        text?: ScriptText;
    }

    export interface Asset {
        name: string;
        size: number;
        url: string;
    }

    export type Version = any;

    export interface File {
        header: Header;
        text: ScriptText;
        version: Version;
    }

    export interface HistoryFile {
        entries: HistoryEntry[];
    }

    export interface HistoryEntry {
        timestamp: number;
        editorVersion: string;
        changes: FileChange[];
    }

    export type FileChange = FileAddedChange | FileRemovedChange | FileEditedChange;

    export interface FileAddedChange {
        type: "added";
        filename: string;
        value: string;
    }

    export interface FileRemovedChange {
        type: "removed";
        filename: string;
        value: string;
    }

    export interface FileEditedChange {
        type: "edited";
        filename: string;

        // We always store the current file so this is a backwards patch
        patch: any;
    }

    export interface WorkspaceProvider {
        listAsync(): Promise<Header[]>; // called from workspace.syncAsync (including upon startup)
        getAsync(h: Header): Promise<File>;
        setAsync(h: Header, prevVersion: Version, text?: ScriptText): Promise<Version>;
        deleteAsync?: (h: Header, prevVersion: Version) => Promise<void>;
        resetAsync(): Promise<void>;
        loadedAsync?: () => Promise<void>;
        getSyncState?: () => pxt.editor.EditorSyncState;

        // optional screenshot support
        saveScreenshotAsync?: (h: Header, screenshot: string, icon: string) => Promise<void>;

        // optional asset (large binary file) support
        saveAssetAsync?: (id: string, filename: string, data: Uint8Array) => Promise<void>;
        listAssetsAsync?: (id: string) => Promise<Asset[]>;

        fireEvent?: (ev: pxt.editor.events.Event) => void;
    }

    export function freshHeader(name: string, modTime: number) {
        let header: Header = {
            target: pxt.appTarget.id,
            targetVersion: pxt.appTarget.versions.target,
            name: name,
            meta: {},
            editor: pxt.JAVASCRIPT_PROJECT_NAME,
            pubId: "",
            pubCurrent: false,
            _rev: null,
            id: U.guidGen(),
            recentUse: modTime,
            modificationTime: modTime,
            cloudUserId: null,
            cloudCurrent: false,
            cloudVersion: null,
            cloudLastSyncTime: 0,
            isDeleted: false,
        }
        return header
    }

    export interface CollapseHistoryOptions {
        interval: number;
        minTime?: number;
        maxTime?: number;
    }

    export function collapseHistory(history: HistoryEntry[], text: ScriptText, options: CollapseHistoryOptions, diff: (a: string, b: string) => unknown, patch: (p: unknown, text: string) => string) {
        const newHistory: HistoryEntry[] = [];

        let current = {...text};
        let lastVersion = pxt.appTarget?.versions?.target;
        let lastTime: number = undefined;
        let lastTimeIndex: number = undefined;
        let lastTimeText: ScriptText = undefined;

        let { interval, minTime, maxTime } = options;

        if (minTime === undefined) {
            minTime = 0;
        }
        if (maxTime === undefined) {
            maxTime = history[history.length - 1].timestamp;
        }

        for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];

            if (entry.timestamp > maxTime) {
                newHistory.unshift(entry);
                current = applyDiff(current, entry, patch);
                continue;
            }
            else if (entry.timestamp < minTime) {
                if (lastTimeIndex !== undefined) {
                    if (lastTimeIndex - i > 1) {
                        newHistory.unshift({
                            timestamp: lastTime,
                            editorVersion: lastVersion,
                            changes: diffScriptText(current, lastTimeText, diff).changes
                        })
                    }
                    else {
                        newHistory.unshift(history[lastTimeIndex]);
                    }
                }
                newHistory.unshift(entry);
                lastTimeIndex = undefined;
                continue;
            }
            else if (lastTimeIndex === undefined) {
                lastTimeText = {...current};
                lastTime = entry.timestamp;
                lastVersion = entry.editorVersion;

                lastTimeIndex = i;
                current = applyDiff(current, entry, patch);
                continue;
            }

            if (lastTime - entry.timestamp > interval) {
                if (lastTimeIndex - i > 1) {
                    newHistory.unshift({
                        timestamp: lastTime,
                        editorVersion: lastVersion,
                        changes: diffScriptText(current, lastTimeText, diff).changes
                    })
                }
                else {
                    newHistory.unshift(history[lastTimeIndex]);
                }

                lastTimeText = {...current}
                current = applyDiff(current, entry, patch);

                lastTimeIndex = i;
                lastTime = entry.timestamp;
                lastVersion = entry.editorVersion;
            }
            else {
                current = applyDiff(current, entry, patch);
            }
        }

        if (lastTimeIndex !== undefined) {
            if (lastTimeIndex) {
                newHistory.unshift({
                    timestamp: lastTime,
                    editorVersion: lastVersion,
                    changes: diffScriptText(current, lastTimeText, diff).changes
                })
            }
            else {
                newHistory.unshift(history[0]);
            }
        }

        return newHistory;
    }

    export function diffScriptText(oldVersion: pxt.workspace.ScriptText, newVersion: pxt.workspace.ScriptText, diff: (a: string, b: string) => unknown): pxt.workspace.HistoryEntry {
        const changes: pxt.workspace.FileChange[] = [];

        for (const file of Object.keys(oldVersion)) {
            if (!(file.endsWith(".ts") || file.endsWith(".jres") || file.endsWith(".py") || file.endsWith(".blocks") || file === "pxt.json")) continue;
            if (newVersion[file] == undefined) {
                changes.push({
                    type: "removed",
                    filename: file,
                    value: oldVersion[file]
                });
            }
            else if (oldVersion[file] !== newVersion[file]) {
                changes.push({
                    type: "edited",
                    filename: file,
                    patch: diff(newVersion[file], oldVersion[file])
                });
            }
        }

        for (const file of Object.keys(newVersion)) {
            if (!(file.endsWith(".ts") || file.endsWith(".jres") || file.endsWith(".py") || file.endsWith(".blocks") || file === "pxt.json")) continue;

            if (oldVersion[file] == undefined) {
                changes.push({
                    type: "added",
                    filename: file,
                    value: newVersion[file]
                });
            }
        }

        if (!changes.length) return undefined;

        return {
            timestamp: Date.now(),
            editorVersion: pxt.appTarget?.versions?.target,
            changes
        }
    }

    export function applyDiff(text: ScriptText, history: pxt.workspace.HistoryEntry, patch: (p: unknown, text: string) => string) {
        const result = { ...text };
        for (const change of history.changes) {
            if (change.type === "added") {
                delete result[change.filename]
            }
            else if (change.type === "removed") {
                result[change.filename] = change.value;
            }
            else {
                result[change.filename] = patch(change.patch, text[change.filename]);
            }
        }

        return result;
    }
}