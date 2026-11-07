import { useCallback, useEffect, useRef, useState } from "react";
import { mailStore } from "../store/mailStore";
import { serverErrorMessage } from "./serverError";

// The few Settings lists that read the server directly instead of the local
// store: terminal logins and connected apps. Each row is a credential, and
// ending one only means something once the server has it, so these lists
// show what the server says and reload after every change. Web and mobile
// share this half; only the rendering differs.

type Token = string | undefined;

function sessionToken(): Token {
  return mailStore.getState().authToken ?? undefined;
}

export type ServerList<Row> = {
  /** null until the first load answers; a load that fails reads as empty. */
  rows: Row[] | null;
  reload: () => Promise<void>;
  /** Run a change with the session's token, then reload. A failure shows the
   *  server's own sentence as a toast and resolves to null. */
  change: <T>(run: (token: Token) => Promise<T>) => Promise<T | null>;
};

export function useServerList<Row>(load: (token: Token) => Promise<Row[]>): ServerList<Row> {
  const [rows, setRows] = useState<Row[] | null>(null);
  // The loader is a fresh closure every render; the latest one is the one to call.
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    try {
      setRows(await loader.current(sessionToken()));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const change = useCallback(
    async <T>(run: (token: Token) => Promise<T>): Promise<T | null> => {
      try {
        const out = await run(sessionToken());
        await reload();
        return out;
      } catch (e) {
        mailStore.getState().pushToast(serverErrorMessage(e), "error");
        return null;
      }
    },
    [reload],
  );

  return { rows, reload, change };
}
