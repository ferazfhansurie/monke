"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Check, Pencil } from "lucide-react";
import { useMonkeStore } from "@/lib/store";

export function ProjectSwitcher() {
  const projects = useMonkeStore((s) => s.projects);
  const activeProjectId = useMonkeStore((s) => s.activeProjectId);
  const projectName = useMonkeStore((s) => s.projectName);
  const renameProject = useMonkeStore((s) => s.renameProject);
  const createProject = useMonkeStore((s) => s.createProject);
  const switchProject = useMonkeStore((s) => s.switchProject);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(projectName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed) renameProject(activeProjectId, trimmed);
    else setDraftName(projectName);
    setEditing(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          setDraftName(projectName);
          setOpen((v) => !v);
        }}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gray-500 hover:bg-white/5 hover:text-gray-300 transition-colors"
      >
        {projectName}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-lg border border-white/10 bg-[#161b22] py-1 shadow-lg">
            <div className="flex items-center gap-1.5 border-b border-white/10 px-2.5 py-1.5">
              {editing ? (
                <input
                  ref={inputRef}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename();
                    if (e.key === "Escape") {
                      setDraftName(projectName);
                      setEditing(false);
                    }
                  }}
                  className="w-full rounded bg-white/5 px-2 py-1 text-[12px] text-white outline-none"
                />
              ) : (
                <>
                  <span className="flex-1 truncate text-[12px] font-semibold text-gray-200">{projectName}</span>
                  <button type="button" onClick={() => setEditing(true)} className="rounded p-1 text-gray-500 hover:bg-white/10 hover:text-gray-300" title="Rename">
                    <Pencil className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>

            <div className="max-h-52 overflow-y-auto py-1">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    switchProject(p.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-white/5"
                >
                  <Check className={`h-3 w-3 shrink-0 ${p.id === activeProjectId ? "text-[#f26522]" : "text-transparent"}`} />
                  <span className="truncate text-[12px] text-gray-300">{p.name}</span>
                </button>
              ))}
            </div>

            <div className="border-t border-white/10 pt-1">
              <button
                type="button"
                onClick={() => {
                  createProject();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-gray-300 hover:bg-white/5"
              >
                <Plus className="h-3 w-3" /> New Project
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
