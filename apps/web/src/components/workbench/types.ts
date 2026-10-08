import {
  Archive,
  Calendar,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Lock,
  Mail,
  Music,
  Presentation,
  Table2,
  Video,
  type LucideIcon,
} from 'lucide-react'

export interface InventoryFile {
  id: string
  source_name: string
  source_kind: string
  original_path: string
  original_filename: string
  format: string
  category: string
  structure: string
  size_bytes: number
  integrity_ok: boolean
  integrity_issues: string[]
  content_earliest: string | null
  content_latest: string | null
  duplicate_copies: number
  likely_scanned: boolean | null
  rows_or_messages: string | null
}

export interface Evidence {
  id: string
  path: string
  source: string
  note: string | null
}

export interface QuestionRow {
  id: string
  ordinal: number
  question: string
  guidance: string | null
  finding_id: string | null
  answer: string | null
  status: 'hypothesis' | 'confirmed' | 'rejected' | null
  confidence: string | null
  created_at: string | null
  evidence: Evidence[]
}

export interface SessionRow {
  id: string
  title: string
  phase: string
  updated_at: string
  steps: number
}

export function formatIcon(format: string, category: string): LucideIcon {
  if (format === 'office_lock') return Lock
  if (format === 'csv') return Table2
  if (category === 'spreadsheet') return FileSpreadsheet
  if (category === 'presentation') return Presentation
  if (category === 'email_archive' || category === 'email') return Mail
  if (category === 'calendar') return Calendar
  if (category === 'image') return FileImage
  if (category === 'audio') return Music
  if (category === 'video') return Video
  if (category === 'archive') return Archive
  if (category === 'web_page' || format === 'markdown') return FileCode
  if (category === 'document' || category === 'text') return FileText
  return File
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function year(d: string | null): string {
  return d ? d.slice(0, 4) : '-'
}
