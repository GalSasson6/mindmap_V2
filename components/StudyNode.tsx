import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { Components } from 'react-markdown';
import { flushSync } from 'react-dom';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import { ChevronDown, ChevronRight, ScanText, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import remarkAutoMath from '../lib/remark-auto-math';
import { resizedData } from '../lib/node-size';
import { nodeFont } from '../lib/node-fonts';

// Markdown setup kept at module level: element types defined inline would be new on every render, so
// React would rebuild their DOM each time. During a finger drag that replaces the very element the
// touch started on, and iOS then stops delivering the touch, freezing the drag after a few pixels.
const TITLE_REMARK = [remarkMath, remarkAutoMath];
const CONTENT_REMARK = [remarkMath, remarkAutoMath, remarkGfm, remarkBreaks];
const REHYPE = [rehypeKatex];
const TITLE_COMPONENTS: Components = {
  p: ({ node, ...props }) => <span {...props} /> // eslint-disable-line @typescript-eslint/no-unused-vars
};
const CONTENT_COMPONENTS: Components = {
  code(props) {
    const { children, className, node, ...rest } = props; // eslint-disable-line @typescript-eslint/no-unused-vars
    const match = /language-(\w+)/.exec(className || '');
    if (match && match[1] === 'typst') {
      const code = String(children).replace(/\n$/, '');
      const encoded = encodeURIComponent(code);
      return <img src={`/api/typst?code=${encoded}`} alt="Typst snippet" style={{ maxWidth: '100%', filter: 'invert(1)' }} />;
    }
    return <code {...rest} className={className}>{children}</code>;
  }
};

export default function StudyNode({ id, data, selected }: { id: string, data: Record<string, any>, selected?: boolean }) {
  const { getEdges, setNodes, getZoom } = useReactFlow();
  // Text direction picked with the RTL/LTR toolbar button; without one the browser detects it
  const textDir = data.dir === 'rtl' || data.dir === 'ltr' ? data.dir : 'auto';
  const [isCollapsed, setIsCollapsed] = useState(data.isCollapsed === 'true' || data.isCollapsed === true);
  // A node just added by hand (double-click, + button) opens straight in edit mode
  const [isEditing, setIsEditing] = useState(!!data.autoEdit);
  
  const titleInputRef = useRef<HTMLInputElement>(null);
  const contentInputRef = useRef<HTMLTextAreaElement>(null);
  const lastTap = useRef<{ time: number, x: number, y: number } | null>(null);
  const tapStart = useRef<{ x: number, y: number } | null>(null);

  // Parsed once per text change, not on every render (a drag re-renders the node each frame)
  const renderedTitle = useMemo(() => (
    <ReactMarkdown remarkPlugins={TITLE_REMARK} rehypePlugins={REHYPE} components={TITLE_COMPONENTS}>
      {data.label || ''}
    </ReactMarkdown>
  ), [data.label]);
  const renderedContent = useMemo(() => data.content ? (
    <ReactMarkdown remarkPlugins={CONTENT_REMARK} rehypePlugins={REHYPE} components={CONTENT_COMPONENTS}>
      {data.content}
    </ReactMarkdown>
  ) : null, [data.content]);

  const edges = getEdges();
  const hasChildren = edges.some(e => e.source === id);

  useEffect(() => {
    if (isEditing && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [isEditing]);

  // Consume the one-time autoEdit flag, with the placeholder title selected so typing replaces it.
  // React Flow keeps a new node hidden until it's measured, and a hidden input can't take focus,
  // so keep trying for a few frames.
  useEffect(() => {
    if (!data.autoEdit) return;
    let tries = 0;
    let frame = 0;
    const focusTitle = () => {
      const input = titleInputRef.current;
      input?.focus();
      if (input && document.activeElement === input) input.select();
      else if (++tries < 30) frame = requestAnimationFrame(focusTitle);
    };
    focusTitle();
    setNodes(nds => nds.map(n => {
      if (n.id !== id) return n;
      const rest = { ...n.data };
      delete rest.autoEdit;
      return { ...n, data: rest };
    }));
    return () => cancelAnimationFrame(frame);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateData = (key: string, value: unknown) => {
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id === id) {
          return { ...n, data: { ...n.data, [key]: value } };
        }
        return n;
      })
    );
  };

  const toggleCollapse = (e: React.MouseEvent) => {
    e.stopPropagation();
    const newCollapsedState = !isCollapsed;
    setIsCollapsed(newCollapsedState);
    updateData('isCollapsed', newCollapsedState.toString());
  };

  const commitEdit = () => {
    setIsEditing(false);
    if (titleInputRef.current) updateData('label', titleInputRef.current.value);
    if (contentInputRef.current) updateData('content', contentInputRef.current.value);
  };

  const handleNodeBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) commitEdit();
  };

  // iOS only opens the keyboard if focus() happens synchronously inside the tap,
  // so render the editor right away and focus it before returning
  const startEditing = () => {
    flushSync(() => {
      setIsEditing(true);
      setIsCollapsed(false);
    });
    titleInputRef.current?.focus();
  };

  // The toolbar's Edit button asks for editing through this event
  useEffect(() => {
    const onEditRequest = (e: Event) => {
      if ((e as CustomEvent<string>).detail === id) startEditing();
    };
    window.addEventListener('edit-node', onEditRequest);
    return () => window.removeEventListener('edit-node', onEditRequest);
  });

  // Double-tap (finger or Apple Pencil) = double-click; the mouse keeps using onDoubleClick
  const handlePointerDown = (e: React.PointerEvent) => {
    tapStart.current = { x: e.clientX, y: e.clientY };
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' || isEditing) return;
    const start = tapStart.current;
    if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
      lastTap.current = null; // it was a drag, not a tap
      return;
    }
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.time < 350 && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30) {
      lastTap.current = null;
      e.stopPropagation();
      startEditing();
    } else {
      lastTap.current = { time: now, x: e.clientX, y: e.clientY };
    }
  };

  // Corner grip resize (works with mouse, finger and pencil)
  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const nodeEl = e.currentTarget.closest('.react-flow__node') as HTMLElement | null;
    const startWidth = nodeEl?.offsetWidth || 260;
    const startHeight = nodeEl?.offsetHeight || 150;
    const startX = e.clientX;
    const startY = e.clientY;
    const zoom = getZoom();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const width = Math.max(100, startWidth + (ev.clientX - startX) / zoom);
      const height = Math.max(20, startHeight + (ev.clientY - startY) / zoom);
      setNodes(nds => nds.map(n => n.id === id ? { ...n, data: resizedData(n.data, width, height, nodeEl) } : n));
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (contentInputRef.current) {
        contentInputRef.current.focus();
      }
    }
  };

  return (
    <div 
      className="study-node custom-node"
      data-font={nodeFont(data.font)?.id}
      tabIndex={-1}
      onBlur={handleNodeBlur}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!isEditing) startEditing();
      }}
      style={{
        background: '#1e293b',
        border: selected ? `2px solid #fbbf24` : `1px solid ${data.color || '#3b82f6'}`,
        borderRadius: '8px',
        padding: '0',
        width: isCollapsed ? 'max-content' : (data.width ? `${data.width}px` : 'max-content'),
        // A width picked by resizing wins over the default minimum
        minWidth: isCollapsed ? '150px' : (data.width ? undefined : (data.isMainTitle ? '360px' : '260px')),
        minHeight: isCollapsed ? 'auto' : (data.height ? `${data.height}px` : 'auto'),
        color: '#f8fafc',
        boxShadow: selected ? '0 0 15px rgba(251, 191, 36, 0.4)' : (data.isMainTitle ? '0 10px 20px rgba(0,0,0,0.4)' : '0 4px 6px -1px rgba(0, 0, 0, 0.2)'),
        overflow: 'hidden',
        transition: 'all 0.2s ease-in-out',
        position: 'relative',
        // The node's handwriting font (the editor's input and textarea inherit it, and formulas'
        // text picks it up through --node-font, see globals.css)
        fontFamily: nodeFont(data.font)?.family,
        ['--node-font' as string]: nodeFont(data.font)?.family
      }}
    >
      <Handle 
        type="target" 
        position={Position.Top} 
        style={{ background: 'transparent', width: '100%', height: '20px', border: 'none', borderRadius: 0, top: '-10px' }} 
      />
      
      {/* Header */}
      <div className="node-header" style={{ 
        position: 'relative',
        background: data.color || (data.isMainTitle ? '#6d28d9' : '#3b82f6'), 
        padding: data.isMainTitle ? '12px 16px' : '8px 12px', 
        display: 'flex', 
        justifyContent: 'space-between',
        alignItems: 'center',
        fontWeight: 'bold',
        fontSize: data.isMainTitle ? '22px' : '14px',
        textTransform: data.isMainTitle ? 'uppercase' : 'none',
        letterSpacing: data.isMainTitle ? '1px' : 'normal'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
            <div 
              className="nodrag"
              onClick={toggleCollapse} 
              onDoubleClick={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              style={{ cursor: 'pointer', display: 'flex', background: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '6px', margin: '-4px 0', flexShrink: 0 }}
            >
              {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
            </div>
          {isEditing ? (
            <input
              ref={titleInputRef}
              dir={textDir}
              className="nodrag nopan nowheel"
              defaultValue={data.label}
              onKeyDown={handleTitleKeyDown}
              style={{
                background: 'rgba(0,0,0,0.2)',
                border: 'none',
                color: 'white',
                fontFamily: 'inherit',
                fontWeight: 'bold',
                fontSize: data.isMainTitle ? '22px' : '14px',
                width: '100%',
                outline: 'none',
                borderRadius: '4px',
                padding: '2px 4px',
                textAlign: 'center'
              }}
            />
          ) : (
            <span 
              dir={textDir}
              className="node-title"
              style={{ cursor: 'text', flexGrow: 1, padding: '2px 4px', textAlign: 'center' }}
            >
              {renderedTitle}
            </span>
          )}
          {/* The model that last wrote this node's AI text or definition: only on the selected node,
              and floated off the header so it never widens the node */}
          {data.aiModel && selected && !isCollapsed && !isEditing && (
            <span className="ai-model-badge" title={`AI model: ${data.aiModel}`}>
              <Sparkles size={10} /> {data.aiModel}
            </span>
          )}
          {data.image && !isEditing && (
            <button
              className="nodrag"
              title="OCR: replace the image with its exact text (O)"
              onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('ocr-node', { detail: id })); }}
              onDoubleClick={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              disabled={!!data.isGenerating}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(0,0,0,0.25)', color: 'white', border: 'none', borderRadius: '4px', padding: '6px 10px', margin: '-3px 0', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', flexShrink: 0 }}
            >
              <ScanText size={14} /> OCR
            </button>
          )}
        </div>
      </div>

      {/* Loading Overlay */}
      {data.isGenerating && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(30, 41, 59, 0.8)',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          zIndex: 10,
          flexDirection: 'column',
          gap: '10px'
        }}>
          <div className="spinner" style={{
            width: '30px', height: '30px',
            border: '3px solid rgba(255,255,255,0.3)',
            borderRadius: '50%',
            borderTopColor: '#fff',
            animation: 'spin 1s ease-in-out infinite'
          }} />
          <style>{`
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
          <span style={{ fontSize: '12px', fontWeight: 'bold' }}>
            {data.isGenerating === 'ocr' ? 'Running OCR...' : data.isGenerating === 'example' ? 'Writing an example...' : data.isGenerating === 'simple' ? 'Simplifying...' : data.isGenerating === 'precise' ? 'Making it more precise...' : data.isGenerating === 'short' ? 'Summarizing (Short)...' : 'Summarizing...'}
          </span>
        </div>
      )}

      {/* Node Content */}
      {!isCollapsed && (data.content || data.image || isEditing) && (
        <div 
          className="node-content" 
          style={{ 
            padding: (!data.content && data.image && !isEditing) ? '0' : (data.isMainTitle ? '20px' : '15px'), 
            fontSize: data.isMainTitle ? '18px' : '14px', 
            cursor: 'text',
            minHeight: (!data.content && data.image && !isEditing) ? '0' : '40px'
          }}
        >
        {data.image && (
          <img 
            src={data.image} 
            alt={data.label} 
            // No native image drag: a long press would lift the picture instead of moving the node
            draggable={false}
            style={{ 
              width: '100%', 
              display: 'block',
              borderRadius: (!data.content && data.image && !isEditing) ? '0 0 8px 8px' : '4px', 
              marginBottom: data.content || isEditing ? '8px' : '0' 
            }} 
          />
        )}
        
        {isEditing ? (
          <textarea
            ref={contentInputRef}
            dir={textDir}
            className="nodrag nopan nowheel"
            defaultValue={data.content || ''}
            style={{
              background: 'rgba(0,0,0,0.1)',
              border: 'none',
              color: 'white',
              fontFamily: 'inherit',
              fontSize: '13px',
              width: '100%',
              minHeight: '80px',
              outline: 'none',
              borderRadius: '4px',
              padding: '8px',
              resize: 'vertical'
            }}
          />
        ) : (
          (data.content || !data.image) && (
            <div 
              dir={textDir}
              style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.4', cursor: 'text', minHeight: '20px' }}
            >
              {data.content ? (
                renderedContent
              ) : (
                <span style={{ opacity: 0.5 }}>Double-tap to edit content...</span>
              )}
            </div>
          )
        )}
      </div>
      )}

      {selected && !isCollapsed && !isEditing && (
        <div className="resize-grip nodrag nopan" onPointerDown={handleResizeStart} title="Drag to resize" />
      )}

      <Handle 
        type="source" 
        position={Position.Bottom} 
        style={{ background: 'transparent', width: '100%', height: '20px', border: 'none', borderRadius: 0, bottom: '-10px' }} 
      />
    </div>
  );
}
