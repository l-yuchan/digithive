import { useCallback, useEffect, useRef, useState } from "react";
import { reportAsync } from "../async";
import {
  createWhiteboardDocument,
  failureMessage,
  isStaleConflict,
  listWhiteboardDocuments,
  readWhiteboardDocument,
  updateWhiteboardDocument,
  type CreateDocumentInput,
  type UpdateDocumentInput,
  type WhiteboardDocument,
  type WhiteboardKind,
  type WhiteboardSummary,
} from "./whiteboardApi";
import type { UpdateResult } from "./DocumentDetail";

const SELECTION_KEY = "digithive.whiteboard.selectedId";
type Filter = { readonly query: string; readonly kind: WhiteboardKind | "" };
type Busy = "create" | "update" | null;

function restoredSelection(): string | null {
  try {
    return window.localStorage.getItem(SELECTION_KEY);
  } catch {
    return null;
  }
}

export function useWhiteboard() {
  const [documents, setDocuments] = useState<readonly WhiteboardSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(restoredSelection);
  const [detail, setDetail] = useState<WhiteboardDocument | null>(null);
  const [filter, setFilter] = useState<Filter>({ query: "", kind: "" });
  const [applied, setApplied] = useState<Filter>({ query: "", kind: "" });
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(selectedId !== null);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const selectedRef = useRef(selectedId);
  const busyRef = useRef<Busy>(null);

  const loadList = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const rows = await listWhiteboardDocuments(applied);
      if (request !== listRequest.current) return;
      setDocuments(rows);
      const current = selectedRef.current;
      const next =
        current && rows.some((document) => document.id === current)
          ? current
          : (rows[0]?.id ?? null);
      if (next === current) return;
      selectedRef.current = next;
      setSelectedId(next);
      setDetailError(null);
      if (next) {
        setDetailLoading(true);
      } else {
        detailRequest.current += 1;
        setDetail(null);
        setDetailLoading(false);
      }
    } catch (error) {
      if (request === listRequest.current) setListError(failureMessage(error, navigator.onLine));
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
  }, [applied]);

  const loadDetail = useCallback(async (id: string): Promise<boolean> => {
    const request = ++detailRequest.current;
    try {
      const document = await readWhiteboardDocument(id);
      if (request !== detailRequest.current || selectedRef.current !== id) return false;
      setDetail(document);
      return true;
    } catch (error) {
      if (request === detailRequest.current && selectedRef.current === id) {
        setDetailError(failureMessage(error, navigator.onLine));
      }
      return false;
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  const reportError = useCallback(
    (error: unknown) => setActionError(failureMessage(error, navigator.onLine)),
    [],
  );

  useEffect(() => {
    Promise.resolve()
      .then(loadList)
      .then(() => undefined, reportError);
    return () => {
      listRequest.current += 1;
    };
  }, [loadList, reportError]);

  useEffect(() => {
    try {
      if (selectedId) window.localStorage.setItem(SELECTION_KEY, selectedId);
      else window.localStorage.removeItem(SELECTION_KEY);
    } catch {
      // Storage is optional; the server remains authoritative for document data.
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return undefined;
    Promise.resolve()
      .then(() => loadDetail(selectedId))
      .then(() => undefined, reportError);
    return () => {
      detailRequest.current += 1;
    };
  }, [loadDetail, reportError, selectedId]);

  const refresh = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    const id = selectedRef.current;
    if (id) {
      setDetailLoading(true);
      setDetailError(null);
    }
    await Promise.all([loadList(), id ? loadDetail(id) : Promise.resolve(false)]);
  }, [loadDetail, loadList]);

  useEffect(() => {
    const onOffline = () => setOnline(false);
    const onOnline = () => {
      setOnline(true);
      reportAsync(refresh(), reportError);
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh, reportError]);

  const select = useCallback((id: string) => {
    selectedRef.current = id;
    setSelectedId(id);
    setDetailLoading(true);
    setDetailError(null);
    setActionError(null);
    setNotice(null);
  }, []);

  const search = useCallback(() => {
    const next = { query: filter.query.trim(), kind: filter.kind };
    setListLoading(true);
    setListError(null);
    if (next.query === applied.query && next.kind === applied.kind) {
      reportAsync(loadList(), (error) => setListError(failureMessage(error, navigator.onLine)));
    } else setApplied(next);
  }, [applied, filter, loadList]);

  const create = useCallback(
    async (input: CreateDocumentInput): Promise<boolean> => {
      if (busyRef.current || !online) return false;
      busyRef.current = "create";
      setBusy("create");
      setActionError(null);
      setNotice(null);
      try {
        const document = await createWhiteboardDocument(input);
        selectedRef.current = document.id;
        setSelectedId(document.id);
        setDetail(document);
        setDetailLoading(true);
        setDetailError(null);
        setNotice("새 문서를 저장했습니다.");
        setListLoading(true);
        setListError(null);
        await loadList();
        return true;
      } catch (error) {
        setActionError(failureMessage(error, navigator.onLine));
        return false;
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [loadList, online],
  );

  const update = useCallback(
    async (document: WhiteboardDocument, input: UpdateDocumentInput): Promise<UpdateResult> => {
      if (busyRef.current || !online) return "failed";
      busyRef.current = "update";
      setBusy("update");
      setActionError(null);
      setNotice(null);
      try {
        const updated = await updateWhiteboardDocument(document.id, input);
        if (selectedRef.current === document.id) setDetail(updated);
        setNotice("선택 문서를 수정했습니다.");
        setListLoading(true);
        setListError(null);
        await loadList();
        return "saved";
      } catch (error) {
        if (isStaleConflict(error)) {
          setActionError("수정 충돌(409): 최신 파일을 읽은 뒤 다시 저장하세요.");
          return "conflict";
        }
        setActionError(failureMessage(error, navigator.onLine));
        return "failed";
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [loadList, online],
  );

  const reloadSelected = useCallback(() => {
    const id = selectedRef.current;
    if (!id) return Promise.resolve(false);
    setDetailLoading(true);
    setDetailError(null);
    return loadDetail(id);
  }, [loadDetail]);

  return {
    documents,
    selectedId,
    detail: detail?.id === selectedId ? detail : null,
    filter,
    setFilter,
    listLoading,
    detailLoading,
    listError,
    detailError,
    actionError,
    notice,
    busy,
    online,
    select,
    search,
    refresh,
    create,
    update,
    reloadSelected,
    reportError,
  };
}
