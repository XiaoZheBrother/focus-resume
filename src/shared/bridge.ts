import type { Command, Document, Position, State } from './model'

export type WindowKind = 'main' | 'panel' | 'capture'
export type AiKind = 'explain' | 'suggest'
export type AiDraft = {
  kind: AiKind
  taskId: string | null
  docId: string | null
  position: Position | null
  input: string
}
export type AiResult = {
  id: string
  draft: AiDraft
  result: string[]
}
export type Snapshot = {
  state: State
  revision: number
  issue: string
  secretReady: boolean
  restoring: boolean
  workspaceVersion: number
  resumeRequest: number
}
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string }
export type ImportDraft = { ticket: string; doc: Document; bytes: Uint8Array } | { existing: Document }
export interface Bridge {
  state(): Promise<Reply<Snapshot>>
  command(command: Command): Promise<Reply<string | undefined>>
  stageImport(): Promise<Reply<ImportDraft | null>>
  finishImport(ticket: string): Promise<Reply<Document>>
  cancelImport(): Promise<Reply<void>>
  document(id: string): Promise<Reply<Uint8Array>>
  backup(): Promise<Reply<boolean>>
  restore(): Promise<Reply<boolean>>
  clear(): Promise<Reply<boolean>>
  secret(value: string): Promise<Reply<void>>
  ai(draft: AiDraft): Promise<Reply<AiResult>>
  copy(value: string): Promise<Reply<void>>
  checkUpdate(): Promise<Reply<string | null>>
  cancelAi(): Promise<Reply<void>>
  adoptAi(id: string, index: number, edit?: string): Promise<Reply<void>>
  desktop(action: 'panel' | 'capture' | 'main' | 'resume' | 'close' | 'quit' | 'releases'): Promise<Reply<void>>
  version(): Promise<Reply<string>>
  onState(listener: (value: Snapshot) => void): () => void
  onNotice(listener: (value: string) => void): () => void
}
