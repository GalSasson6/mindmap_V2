import React, { useState } from 'react';
import { Node } from '@xyflow/react';
import { BookOpen, X, Search, Edit2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import remarkAutoMath from '../lib/remark-auto-math';

interface DefinitionsPanelProps {
  nodes: Node[];
  onClose: () => void;
  onNodeClick: (nodeId: string) => void;
}

export default function DefinitionsPanel({ nodes, onClose, onNodeClick }: DefinitionsPanelProps) {
  const [searchTerm, setSearchTerm] = useState('');
  
  // Only show nodes that have a label (or shortDescription) and aren't images
  const definedNodes = nodes.filter(n => n.data.label && n.data.label !== 'Pasted Image' && n.data.label !== 'New Topic');
  
  const filteredNodes = definedNodes.filter(n => {
    const labelMatch = (n.data.label as string || '').toLowerCase().includes(searchTerm.toLowerCase());
    const descMatch = (n.data.shortDescription as string || '').toLowerCase().includes(searchTerm.toLowerCase());
    return labelMatch || descMatch;
  });

  return (
    <div style={{
      position: 'absolute',
      top: 70,
      right: 'max(16px, env(safe-area-inset-right))',
      width: 'min(340px, calc(100% - 32px))',
      maxHeight: 'calc(100% - 140px)',
      background: '#1e293b',
      border: '1px solid #334155',
      borderRadius: '8px',
      boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 1000,
      color: '#f8fafc',
      overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 16px',
        background: '#0f172a',
        borderBottom: '1px solid #334155'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold' }}>
          <BookOpen size={18} />
          <span>Definitions</span>
        </div>
        <button 
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', padding: '10px', margin: '-10px' }}
        >
          <X size={20} />
        </button>
      </div>
      
      <div style={{ padding: '12px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          background: '#334155',
          borderRadius: '4px',
          padding: '6px 10px',
          gap: '8px'
        }}>
          <Search size={14} color="#94a3b8" />
          <input 
            type="text" 
            placeholder="Search definitions..." 
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'white',
              width: '100%',
              outline: 'none',
              fontSize: '13px'
            }}
          />
        </div>
      </div>
      
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '0 12px 12px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        overscrollBehavior: 'contain'
      }}>
        {filteredNodes.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#94a3b8', padding: '20px', fontSize: '13px' }}>
            No definitions found.
          </div>
        ) : (
          filteredNodes.map(node => (
            <div 
              key={node.id} 
              className="definition-card"
              onClick={() => onNodeClick(node.id)}
              style={{
                background: '#0f172a',
                border: `1px solid ${node.data.color || '#334155'}`,
                borderRadius: '6px',
                padding: '10px',
                cursor: 'pointer',
                transition: 'all 0.2s'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span dir="auto" style={{ fontWeight: 'bold', fontSize: '14px', color: '#60a5fa' }}>
                  <ReactMarkdown remarkPlugins={[remarkMath, remarkAutoMath]} rehypePlugins={[rehypeKatex]} components={{ p: ({node, ...props}) => <span {...props} /> }}>
                    {node.data.label as string || 'Untitled'}
                  </ReactMarkdown>
                </span>
                <Edit2 size={12} color="#94a3b8" />
              </div>
              <div dir="auto" style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.4' }}>
                {node.data.shortDescription ? (
                  <ReactMarkdown 
                    remarkPlugins={[remarkMath, remarkAutoMath, remarkBreaks]} 
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      code(props) {
                        const {children, className, node, ...rest} = props
                        const match = /language-(\w+)/.exec(className || '')
                        if (match && match[1] === 'typst') {
                          const code = String(children).replace(/\n$/, '');
                          const encoded = encodeURIComponent(code);
                          return <img src={`/api/typst?code=${encoded}`} alt="Typst snippet" style={{ maxWidth: '100%', filter: 'invert(1)' }} />
                        }
                        return <code {...rest} className={className}>{children}</code>
                      }
                    }}
                  >
                    {node.data.shortDescription as string}
                  </ReactMarkdown>
                ) : (
                  <span style={{ fontStyle: 'italic', color: '#64748b' }}>No description available.</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
