import { useCallback, useEffect, useState } from 'react'
import { request } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { cn } from '../lib/utils'

interface Folder {
  id: number
  name: string
  parent_id: number
}

interface Document {
  id: number
  folder_id: number
  title: string
  content_type: string
  size: number
  created_by: string
}

interface SearchHit {
  id: number
  title: string
  content: string
  content_type: string
}

const CT_LABEL: Record<string, string> = { text: '文本', markdown: 'Markdown', docx: 'Word', pdf: 'PDF' }

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

export default function Knowledge() {
  const [folders, setFolders] = useState<Folder[]>([])
  const [selected, setSelected] = useState(0)
  const [docs, setDocs] = useState<Document[]>([])
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [error, setError] = useState('')

  const [folderDialog, setFolderDialog] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [uploadDialog, setUploadDialog] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [uploadFolder, setUploadFolder] = useState(0)
  const [grantDialog, setGrantDialog] = useState(false)
  const [grantFolder, setGrantFolder] = useState<Folder | null>(null)
  const [grantTarget, setGrantTarget] = useState('')

  const loadFolders = useCallback(async () => {
    try {
      const data = await request('/api/admin/kb/folders')
      setFolders(data.folders)
    } catch (err: any) {
      setError(err.message)
    }
  }, [])

  const loadDocs = useCallback(async () => {
    try {
      const data = await request(`/api/admin/kb/documents?folder_id=${selected}`)
      setDocs(data.documents)
    } catch (err: any) {
      setError(err.message)
    }
  }, [selected])

  useEffect(() => { loadFolders() }, [loadFolders])
  useEffect(() => { loadDocs() }, [loadDocs])

  const searching = query.trim() !== ''

  async function doSearch() {
    try {
      const data = await request(`/api/admin/kb/search?q=${encodeURIComponent(query)}`)
      setHits(data.results)
      setError('')
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function createFolder() {
    try {
      await request('/api/admin/kb/folders', { method: 'POST', body: JSON.stringify({ name: folderName }) })
      setFolderDialog(false)
      setFolderName('')
      loadFolders()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function uploadDoc() {
    if (!file) return
    const fd = new FormData()
    fd.append('file', file)
    fd.append('title', title || file.name)
    fd.append('folder_id', String(uploadFolder))
    try {
      await request('/api/admin/kb/upload', { method: 'POST', body: fd })
      setUploadDialog(false)
      setFile(null)
      setTitle('')
      if (searching) doSearch()
      loadDocs()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function deleteDoc(id: number, docTitle: string) {
    if (!window.confirm(`删除文档「${docTitle}」?`)) return
    try {
      await request(`/api/admin/kb/documents/${id}`, { method: 'DELETE' })
      if (searching) doSearch()
      loadDocs()
    } catch (err: any) {
      setError(err.message)
    }
  }

  async function grant() {
    if (!grantFolder || !grantTarget.trim()) return
    const isGroup = grantTarget.trim().startsWith('@')
    try {
      await request(`/api/admin/kb/folders/${grantFolder.id}/grant`, {
        method: 'PUT',
        body: JSON.stringify(isGroup ? { group: grantTarget.trim().slice(1) } : { username: grantTarget.trim() }),
      })
      setGrantDialog(false)
      setGrantTarget('')
    } catch (err: any) {
      setError(err.message)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">知识库管理</h1>
      {error && <div className="text-sm text-destructive">{error}</div>}

      <div className="grid grid-cols-[240px_1fr] gap-6">
        <Card>
          <CardHeader>
            <CardTitle>文件夹</CardTitle>
            <CardDescription>根目录对所有用户可见;授权范围仅作用于已授权用户</CardDescription>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setFolderDialog(true)}>新建文件夹</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {[{ id: 0, name: '全部 / 根目录', parent_id: 0 }, ...folders].map((f) => (
                <div key={f.id} className="flex w-full items-center justify-between">
                  <Button
                    variant="ghost"
                    onClick={() => setSelected(f.id)}
                    className={cn('h-auto flex-1 justify-start whitespace-normal px-3 py-2 text-left text-sm', selected === f.id && 'bg-accent')}
                  >
                    {f.name}
                  </Button>
                  {f.id !== 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2"
                      onClick={() => {
                        setGrantFolder(f)
                        setGrantTarget('')
                        setGrantDialog(true)
                      }}
                    >
                      授权
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>文档</CardTitle>
            <div className="flex justify-end gap-2">
              <Input
                className="w-64"
                placeholder="搜索知识库…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doSearch()}
              />
              <Button variant="outline" onClick={doSearch}>搜索</Button>
              <Button size="sm" onClick={() => { setUploadDialog(true); setUploadFolder(selected) }}>上传文档</Button>
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标题</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>大小</TableHead>
                  <TableHead>上传者</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {searching
                  ? hits.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell>
                        <div className="font-medium">{h.title}</div>
                        <div className="text-xs text-muted-foreground">{h.content.slice(0, 80)}…</div>
                      </TableCell>
                      <TableCell><Badge variant="secondary">{CT_LABEL[h.content_type] ?? h.content_type}</Badge></TableCell>
                      <TableCell className="text-muted-foreground">{fmtSize(h.content.length)}</TableCell>
                      <TableCell />
                      <TableCell className="text-right">
                        <Button size="sm" variant="destructive" onClick={() => deleteDoc(h.id, h.title)}>删除</Button>
                      </TableCell>
                    </TableRow>
                  ))
                  : docs.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>{d.title}</TableCell>
                      <TableCell><Badge variant="secondary">{CT_LABEL[d.content_type] ?? d.content_type}</Badge></TableCell>
                      <TableCell>{fmtSize(d.size)}</TableCell>
                      <TableCell>{d.created_by}</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="destructive" onClick={() => deleteDoc(d.id, d.title)}>删除</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                {!searching && docs.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">暂无文档</TableCell></TableRow>
                )}
                {searching && hits.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">无搜索结果</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Dialog open={folderDialog} onOpenChange={setFolderDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>新建文件夹</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>名称</Label>
              <Input value={folderName} onChange={(e) => setFolderName(e.target.value)} />
            </div>
            <Button className="w-full" onClick={createFolder}>创建</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={uploadDialog} onOpenChange={setUploadDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>上传文档</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>文件(txt / md / docx / pdf)</Label>
              <Input type="file" accept=".txt,.md,.docx,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-1">
              <Label>标题(留空使用文件名)</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>文件夹</Label>
              <Select value={String(uploadFolder)} onValueChange={(v) => setUploadFolder(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">全部 / 根目录</SelectItem>
                  {folders.map((f) => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" disabled={!file} onClick={uploadDoc}>上传</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={grantDialog} onOpenChange={setGrantDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>授权文件夹「{grantFolder?.name}」</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>用户名或组(组名以 @ 开头,如 @研发组)</Label>
              <Input value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)} />
            </div>
            <Button className="w-full" disabled={!grantTarget.trim()} onClick={grant}>授权</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
