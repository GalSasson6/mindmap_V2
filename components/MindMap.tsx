'use client';

import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  Panel,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  MarkerType
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { flushSync } from 'react-dom';
import { Plus, LayoutTemplate, BookOpen, Settings, Pencil, Crown, Sparkles, Zap, ScanText, Link2, Undo2, Trash2, X, ImagePlus, ClipboardPaste, PilcrowLeft, PilcrowRight, Lightbulb, Brush, Baby, Minus, GraduationCap, Shrink } from 'lucide-react';
import StudyNode from './StudyNode';
import DefinitionsPanel from './DefinitionsPanel';
import DrawPad, { type SavedDrawing } from './DrawPad';
import { nodeFont, nextNodeFont } from '../lib/node-fonts';
import dagre from 'dagre';
import { readJson } from '../lib/read-json';
import { resizedData, nodeElement, fittedWidth } from '../lib/node-size';
import { WORKING_MODELS, isWorkingModel } from '../lib/models';

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'TB') => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  const isHorizontal = direction === 'LR';
  dagreGraph.setGraph({ rankdir: direction, ranksep: 100, nodesep: 100 });

  const visibleNodes = [...nodes.filter(n => !n.hidden)];
  
  // Sort nodes based on their current X position (if TB) or Y position (if LR)
  // This helps Dagre preserve the relative left/right or top/bottom ordering of nodes.
  visibleNodes.sort((a, b) => {
    if (isHorizontal) {
      return a.position.y - b.position.y;
    }
    return a.position.x - b.position.x;
  });

  const nodeDimensions = new Map();

  visibleNodes.forEach((node) => {
    const width = node.data?.width || node.measured?.width || 280;
    const height = node.data?.height || node.measured?.height || 150;
    nodeDimensions.set(node.id, { width, height });
    dagreGraph.setNode(node.id, { width, height });
  });

  // Insert edges into dagre graph. If a target is visually above/left of a source, 
  // we flip the edge in dagre so it preserves the visual order instead of swapping the nodes.
  edges.filter(e => !e.hidden).forEach((edge) => {
    const sourceNode = visibleNodes.find(n => n.id === edge.source);
    const targetNode = visibleNodes.find(n => n.id === edge.target);

    if (sourceNode && targetNode) {
      let dagreSource = edge.source;
      let dagreTarget = edge.target;

      if (isHorizontal) {
        if (targetNode.position.x < sourceNode.position.x) {
          dagreSource = edge.target;
          dagreTarget = edge.source;
        }
      } else {
        if (targetNode.position.y < sourceNode.position.y) {
          dagreSource = edge.target;
          dagreTarget = edge.source;
        }
      }

      dagreGraph.setEdge(dagreSource, dagreTarget);
    }
  });

  dagre.layout(dagreGraph);

  const newNodes = nodes.map((node) => {
    if (node.hidden) return node;
    const nodeWithPosition = dagreGraph.node(node.id);
    if (!nodeWithPosition) return node;
    
    const dims = nodeDimensions.get(node.id) || { width: 280, height: 150 };
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - dims.width / 2,
        y: nodeWithPosition.y - dims.height / 2,
      },
    };
  });

  return { nodes: newNodes, edges };
};

// The iPad's connection sometimes drops for a moment (waking up, switching networks): Safari then
// fails the request ("Load failed") or gets a reply cut off mid-way. Retry once after a short pause.
// Levels of a Simplify node, matching SIMPLE_LEVELS in the summarize route
const SIMPLE_MAX_LEVEL = 4;

const postSummarize = async (init: RequestInit) => {
  const attempt = async () => readJson(await fetch('/api/summarize', init), 'AI request');
  try {
    return await attempt();
  } catch {
    await new Promise(resolve => setTimeout(resolve, 1000));
    return attempt();
  }
};

function Flow({ courseName }: { courseName: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);
  const [isDefinitionsOpen, setIsDefinitionsOpen] = useState(false);
  const [maxWordsQ, setMaxWordsQ] = useState<number>(15);
  // Gemini model picked in the settings, remembered on this device; '' = the server's default
  // (a model remembered from before the list was limited to working ones goes back to the default)
  const [model, setModel] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('geminiModel');
      return isWorkingModel(saved) ? saved : '';
    } catch { return ''; }
  });
  const [defaultModel, setDefaultModel] = useState('');
  const [maxWordsR, setMaxWordsR] = useState<number>(50);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(`You are a helpful study assistant. 
Summarize the provided node content in Hebrew. 
If the content contains an incomplete list of terms (e.g., "- term:" or "- term -") waiting for definitions, your task is to FILL IN the definitions for those terms concisely. Keep the original list format and append the definitions. Use the provided Parent Context to understand the specific topic.
If the node refers to a concept with an accurate/formal definition (like a theorem, e.g., "למת הניפוח"), you MUST state its exact formal definition clearly.

CRITICAL RULE: Format your response with frequent line breaks. Do NOT write long, wide sentences. Break sentences into multiple shorter lines so the text is not too wide on the screen.
Use simple, everyday, informal language to make it easy to understand, while keeping definitions mathematically accurate.
Use markdown math nodes (KaTeX) where appropriate if math is involved.
When explaining, use LaTeX colors for keywords and variables (e.g., $\\textcolor{red}{\\text{Example}}$). I MUST wrap every LaTeX command in dollar signs (single $ for inline, double $$ for block) so it renders visually. I will NEVER output raw LaTeX code (like \\textcolor{...}) as plain text. When using Hebrew inside \\text{}, I will ensure it respects Right-to-Left direction. I will not use colors in codes.
Return ONLY the summarized or completed text, no extra conversational padding.`);
  const [connectLine, setConnectLine] = useState<{startX: number, startY: number, currentX: number, currentY: number} | null>(null);
  const dragState = useRef<{ type: 'right' | 'middle', sourceId: string, startWidth?: number, startHeight?: number, startX?: number, startY?: number } | null>(null);
  const undoRef = useRef<{ id: string, data: any } | null>(null);
  const [hasUndo, setHasUndo] = useState(false);
  // Touch "connect" mode: the source node waits for the next tapped node
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const paneTap = useRef<{ downX: number, downY: number, lastTime: number, lastX: number, lastY: number }>({ downX: 0, downY: 0, lastTime: 0, lastX: 0, lastY: 0 });
  const lastTouchAdd = useRef(0);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [isPasteBoxOpen, setIsPasteBoxOpen] = useState(false);
  const pasteBoxRef = useRef<HTMLDivElement>(null);
  // The node being drawn into on the free-draw canvas, if any
  const [drawNodeId, setDrawNodeId] = useState<string | null>(null);

  const { fitView, setCenter, screenToFlowPosition, getZoom, getNodes, getEdges } = useReactFlow();

  const handleDefinitionClick = useCallback((nodeId: string) => {
    const node = getNodes().find(n => n.id === nodeId);
    if (node) {
      setCenter(node.position.x + (node.measured?.width || 260) / 2, node.position.y + (node.measured?.height || 130) / 2, { zoom: 1.2, duration: 800 });
      // On a narrow (portrait iPad) screen the panel would cover the node it just centered
      if (window.innerWidth < 900) setIsDefinitionsOpen(false);
    }
  }, [getNodes, setCenter]);

  const nodeTypes = useMemo(() => ({ study: StudyNode, default: StudyNode }), []);

  useEffect(() => {
    fetch(`/api/mindmap?course=${encodeURIComponent(courseName)}`)
      .then((res) => readJson(res, 'Loading the mind map'))
      .then((data) => {
        if (data.nodes) setNodes(data.nodes);
        if (data.edges) setEdges(data.edges);
        setLoading(false);
        setTimeout(() => fitView({ duration: 800, padding: 0.2 }), 100);
      })
      .catch((err) => {
        console.error('Failed to load mindmap data', err);
        setLoading(false);
      });
  }, [setNodes, setEdges, fitView, courseName]);


  useEffect(() => {
    if (loading) return;
    // Only save when something changed, one request at a time. A failed save is retried on
    // the next tick (lastSaved isn't updated), so it's a warning rather than an error.
    let lastSaved = '';
    let inFlight = false;
    const save = () => {
      const currentNodes = getNodes();
      if (inFlight || currentNodes.length === 0) return;
      const body = JSON.stringify({ nodes: currentNodes, edges: getEdges() });
      if (body === lastSaved) return;

      inFlight = true;
      fetch(`/api/mindmap?course=${encodeURIComponent(courseName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
        .then(res => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          lastSaved = body;
        })
        .catch(err => console.warn('Autosave failed, will retry:', err.message))
        .finally(() => { inFlight = false; });
    };
    const timer = setInterval(save, 2000);
    // iPad suspends background tabs/apps right away, so save the moment the app is switched away from
    const onHide = () => { if (document.visibilityState === 'hidden') save(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', save);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', save);
    };
  }, [loading, getNodes, getEdges, courseName]);

  useEffect(() => {
    try { localStorage.setItem('geminiModel', model); } catch {}
  }, [model]);

  // The model list ships with the app; only the server's default model is asked for,
  // when the settings are opened, and again on the next opening if that request failed
  useEffect(() => {
    if (!isSettingsOpen || defaultModel) return;
    fetch('/api/models')
      .then(res => readJson(res, 'Loading the default model'))
      .then(data => setDefaultModel(data.defaultModel || ''))
      .catch(err => console.warn('Loading the default model failed:', err));
  }, [isSettingsOpen, defaultModel]);

  const rememberForUndo = useCallback((node: Node) => {
    undoRef.current = { id: node.id, data: { ...node.data } };
    setHasUndo(true);
  }, []);

  const buildSummaryContent = useCallback((node: Node, currentNodes: Node[]) => {
    const incomingEdges = getEdges().filter(e => e.target === node.id);
    const parentNodes = incomingEdges.map(e => currentNodes.find(n => n.id === e.source)).filter(Boolean);
    const parentTitles = parentNodes.map(n => n?.data?.label).filter(Boolean).join(', ');

    let contentToSummarize = `Course Topic: ${courseName}\n\n`;
    if (parentTitles) {
      contentToSummarize += `Parent Context: ${parentTitles}\n\n`;
    }
    contentToSummarize += `Title: ${node.data.label || 'None'}\n\nContent:\n${node.data.content || ''}`;
    return contentToSummarize;
  }, [getEdges, courseName]);

  // Verbatim OCR: replace an image node's image with its exact transcription (no summarizing)
  const runOcr = useCallback((nodeId: string) => {
    const target = getNodes().find(n => n.id === nodeId);
    if (!target?.data.image || target.data.isGenerating) return;

    rememberForUndo(target);
    setNodes(nds => nds.map(node =>
      node.id === nodeId ? { ...node, data: { ...node.data, isGenerating: 'ocr' } } : node
    ));

    postSummarize({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ocr', image: target.data.image, model })
    })
    .then(data => {
      if (data.error || !data.content) throw new Error(data.error || 'Empty OCR result');
      setNodes(nds => nds.map(node => {
        if (node.id !== nodeId) return node;
        const newData: Record<string, unknown> = { ...node.data, content: data.content, isGenerating: false, isCollapsed: false, aiModel: data.model };
        if (data.title) newData.label = data.title;
        delete newData.image;
        delete newData.height;
        newData.width = Math.min(Number(newData.width) || 260, 450);
        return { ...node, data: newData };
      }));
    })
    .catch(err => {
      console.error('OCR error:', err);
      setNodes(nds => nds.map(node =>
        node.id === nodeId ? { ...node, data: { ...node.data, isGenerating: false } } : node
      ));
      alert(`OCR failed: ${err.message}`);
    });
  }, [getNodes, setNodes, rememberForUndo, model]);

  // The OCR button lives inside StudyNode; it asks for OCR through this event
  useEffect(() => {
    const onOcrRequest = (e: Event) => runOcr((e as CustomEvent<string>).detail);
    window.addEventListener('ocr-node', onOcrRequest);
    return () => window.removeEventListener('ocr-node', onOcrRequest);
  }, [runOcr]);

  // 1/2/3: color the selected node, and generate its short definition in the background
  const applyColor = useCallback((color: string) => {
    const currentNodes = getNodes();
    const selectedNode = currentNodes.find(n => n.selected);

    if (selectedNode) rememberForUndo(selectedNode);

    setNodes(nds => nds.map(node => {
      if (node.selected) return { ...node, data: { ...node.data, color } };
      return node;
    }));

    if (selectedNode && (selectedNode.data.content || selectedNode.data.label || selectedNode.data.image)) {
      postSummarize({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          content: buildSummaryContent(selectedNode, currentNodes), 
          mode: 'short',
          image: selectedNode.data.image,
          maxWords: maxWordsQ,
          systemPrompt: systemPrompt,
          model
        })
      })
      .then(data => {
        if (!data.error && data.content) {
          setNodes(nds => nds.map(node => 
            node.id === selectedNode.id ? { ...node, data: { ...node.data, shortDescription: data.content, aiModel: data.model } } : node
          ));
        }
      })
      .catch(err => {
        // Runs in the background, so a dropped connection is a warning, not an error popup
        console.warn('Auto summarize failed:', err);
      });
    }
  }, [getNodes, setNodes, rememberForUndo, buildSummaryContent, maxWordsQ, systemPrompt, model]);

  // 4: toggle "main title" styling
  // Example button (T): a new green node, linked from the selected one, with a worked example of its term.
  // Simplify button (Y): a new amber node, linked the same way, explaining the topic informally and as simply as possible
  const generateLinkedNode = useCallback((kind: 'example' | 'simple') => {
    const currentNodes = getNodes();
    const sourceNode = currentNodes.find(n => n.selected);
    if (!sourceNode || !(sourceNode.data.content || sourceNode.data.label || sourceNode.data.image)) return;
    if (sourceNode.data.isGenerating) return;

    const setSourceGenerating = (value: string | false) => setNodes(nds => nds.map(node =>
      node.id === sourceNode.id ? { ...node, data: { ...node.data, isGenerating: value } } : node
    ));
    setSourceGenerating(kind);

    postSummarize({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: buildSummaryContent(sourceNode, currentNodes),
        mode: kind,
        ...(kind === 'simple' ? { level: 1 } : {}),
        image: sourceNode.data.image,
        systemPrompt,
        model
      })
    })
    .then(data => {
      if (data.error || !data.content) throw new Error(data.error || `Empty ${kind === 'simple' ? 'explanation' : 'example'}`);
      setSourceGenerating(false);
      // To the right of the source node
      const sourceWidth = sourceNode.measured?.width || Number(sourceNode.data.width) || 260;
      const newId = `node-${Date.now()}`;
      setNodes(nds => [...nds, {
        id: newId,
        type: 'study',
        position: { x: sourceNode.position.x + sourceWidth + 100, y: sourceNode.position.y },
        data: {
          label: data.title || `${kind === 'simple' ? 'Simply' : 'Example'}: ${sourceNode.data.label || ''}`.trim(),
          content: data.content,
          color: kind === 'simple' ? '#f59e0b' : '#10b981',
          ...(kind === 'simple' ? { simpleLevel: 1 } : {}),
          width: 320,
          aiModel: data.model,
          ...(sourceNode.data.dir ? { dir: sourceNode.data.dir } : {})
        }
      }]);
      setEdges(eds => addEdge({
        id: `edge-${Date.now()}`,
        source: sourceNode.id,
        target: newId,
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed }
      }, eds));
    })
    .catch(err => {
      console.error(`${kind} node error:`, err);
      setSourceGenerating(false);
      alert(`Failed to create ${kind === 'simple' ? 'a simple explanation' : 'an example'}: ${err.message}`);
    });
  }, [getNodes, setNodes, setEdges, buildSummaryContent, systemPrompt, model]);

  // A node without a Simplify level: rewrite its text one step simpler or more precise than it is now
  const refineNode = useCallback((node: Node, currentNodes: Node[], delta: 1 | -1) => {
    if (!node.data.content) return;
    rememberForUndo(node);
    const setGenerating = (value: string | false) => setNodes(nds => nds.map(n =>
      n.id === node.id ? { ...n, data: { ...n.data, isGenerating: value } } : n
    ));
    setGenerating(delta > 0 ? 'precise' : 'simple');

    postSummarize({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: buildSummaryContent(node, currentNodes),
        mode: 'refine',
        direction: delta > 0 ? 'precise' : 'simpler',
        image: node.data.image,
        systemPrompt,
        model
      })
    })
    .then(data => {
      if (data.error || !data.content) throw new Error(data.error || 'Empty rewrite');
      setNodes(nds => nds.map(n => n.id === node.id
        ? { ...n, data: { ...n.data, content: data.content, isGenerating: false, aiModel: data.model } }
        : n));
    })
    .catch(err => {
      console.error('Refine error:', err);
      setGenerating(false);
      alert(`Failed to rewrite the node: ${err.message}`);
    });
  }, [setNodes, rememberForUndo, buildSummaryContent, systemPrompt, model]);

  // Rewrite the selected node one step simpler (-1) or more precise (+1), replacing its text in place.
  // A Simplify node moves along its levels, from 1 (plain intuition) to 4 (textbook terms); any other
  // node with text (an older Simplify node, an example, a summary) is rewritten relative to its current text
  const changeSimpleLevel = useCallback((delta: 1 | -1) => {
    const currentNodes = getNodes();
    const node = currentNodes.find(n => n.selected);
    if (!node || node.data.isGenerating) return;
    // Simplify nodes from before the levels existed have no level; they were made at level 1
    const currentLevel = Number(node.data.simpleLevel) || (node.data.color === '#f59e0b' ? 1 : 0);
    if (!currentLevel) {
      refineNode(node, currentNodes, delta);
      return;
    }
    const level = currentLevel + delta;
    if (level < 1 || level > SIMPLE_MAX_LEVEL) return;
    // Explain the parent's topic again; without a parent the node's own text is the topic
    const parentEdge = getEdges().find(e => e.target === node.id);
    const parent = parentEdge && currentNodes.find(n => n.id === parentEdge.source);
    const topic = parent || node;

    rememberForUndo(node);
    const setGenerating = (value: string | false) => setNodes(nds => nds.map(n =>
      n.id === node.id ? { ...n, data: { ...n.data, isGenerating: value } } : n
    ));
    setGenerating(delta > 0 ? 'precise' : 'simple');

    postSummarize({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: buildSummaryContent(topic, currentNodes),
        mode: 'simple',
        level,
        previous: node.data.content,
        image: topic.data.image,
        systemPrompt,
        model
      })
    })
    .then(data => {
      if (data.error || !data.content) throw new Error(data.error || 'Empty explanation');
      setNodes(nds => nds.map(n => n.id === node.id
        ? { ...n, data: { ...n.data, content: data.content, simpleLevel: level, isGenerating: false, aiModel: data.model } }
        : n));
    })
    .catch(err => {
      console.error('Simplify level error:', err);
      setGenerating(false);
      alert(`Failed to rewrite the explanation: ${err.message}`);
    });
  }, [getNodes, getEdges, setNodes, rememberForUndo, buildSummaryContent, refineNode, systemPrompt, model]);

  // Free draw: the drawing replaces the node's image (an existing image is drawn on, not lost)
  // The node keeps the strokes too, so reopening draw mode edits them; null means the drawing was erased away
  const saveDrawing = useCallback((result: { dataUrl: string, width: number, height: number, drawing: SavedDrawing } | null) => {
    const target = getNodes().find(n => n.id === drawNodeId);
    if (target) rememberForUndo(target);
    setNodes(nds => nds.map(node => {
      if (node.id !== drawNodeId) return node;
      const newData: Record<string, unknown> = result
        ? { ...node.data, image: result.dataUrl, drawing: result.drawing, width: Math.max(260, Math.min(result.width, 600)) }
        : { ...node.data };
      if (!result) { delete newData.image; delete newData.drawing; }
      delete newData.height;
      return { ...node, data: newData };
    }));
    setDrawNodeId(null);
  }, [drawNodeId, getNodes, setNodes, rememberForUndo]);

  // RTL/LTR button: flip the selected node's text direction (an auto-detected node starts at RTL)
  const toggleTextDirection = useCallback(() => {
    const selectedNode = getNodes().find(n => n.selected);
    if (selectedNode) rememberForUndo(selectedNode);
    setNodes(nds => nds.map(node =>
      node.selected ? { ...node, data: { ...node.data, dir: node.data.dir === 'rtl' ? 'ltr' : 'rtl' } } : node
    ));
  }, [getNodes, setNodes, rememberForUndo]);

  // Font button: cycle the selected node through the handwriting fonts and the app's standard font
  const cycleNodeFont = useCallback(() => {
    const selectedNode = getNodes().find(n => n.selected);
    if (!selectedNode) return;
    rememberForUndo(selectedNode);
    const font = nextNodeFont(selectedNode.data.font);
    setNodes(nds => nds.map(node => {
      if (node.id !== selectedNode.id) return node;
      const data: Record<string, unknown> = { ...node.data, font };
      if (!font) delete data.font;
      return { ...node, data };
    }));
  }, [getNodes, setNodes, rememberForUndo]);

  const toggleMainTitle = useCallback(() => {
    setNodes(nds => nds.map(node => {
      if (node.selected) {
        const becomingMain = !node.data.isMainTitle;
        return { ...node, data: { ...node.data, isMainTitle: becomingMain, color: becomingMain ? '#8b4513' : '#3b82f6' } };
      }
      return node;
    }));
  }, [setNodes]);

  // R = full summary ('normal'), Q = short summary; replaces the node's content
  const summarizeSelected = useCallback((mode: 'normal' | 'short') => {
    const currentNodes = getNodes();
    const selectedNode = currentNodes.find(n => n.selected);
    if (!selectedNode || !(selectedNode.data.content || selectedNode.data.label || selectedNode.data.image)) return;
    if (selectedNode.data.isGenerating) return;

    rememberForUndo(selectedNode);

    setNodes(nds => nds.map(node => 
      node.id === selectedNode.id ? { ...node, data: { ...node.data, isGenerating: mode } } : node
    ));

    postSummarize({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        content: buildSummaryContent(selectedNode, currentNodes), 
        mode,
        image: selectedNode.data.image,
        maxWords: mode === 'short' ? maxWordsQ : maxWordsR,
        systemPrompt: systemPrompt,
        model
      })
    })
    .then(data => {
      if (data.error) {
        console.warn('Summarize error:', data.error);
        setNodes(nds => nds.map(node => 
          node.id === selectedNode.id ? { ...node, data: { ...node.data, isGenerating: false } } : node
        ));
        alert(`Error: ${data.error}`);
      } else if (data.content) {
        setNodes(nds => nds.map(node => {
          if (node.id !== selectedNode.id) return node;
          const newData: Record<string, unknown> = { ...node.data, content: data.content, isGenerating: false, isCollapsed: false, aiModel: data.model };
          // The AI text replaces an analyzed image; drop the image-sized dimensions with it
          if (newData.image) {
            if (data.title) newData.label = data.title;
            delete newData.image;
            delete newData.height;
            newData.width = Math.min(Number(newData.width) || 260, 450);
          }
          return { ...node, data: newData };
        }));
      }
    })
    .catch(err => {
      console.error('Summarize catch error:', err);
      setNodes(nds => nds.map(node => 
        node.id === selectedNode.id ? { ...node, data: { ...node.data, isGenerating: false } } : node
      ));
      alert(`Failed to fetch summary: ${err.message}`);
    });
  }, [getNodes, setNodes, rememberForUndo, buildSummaryContent, maxWordsQ, maxWordsR, systemPrompt, model]);

  const deleteSelection = useCallback(() => {
    const removed = new Set(getNodes().filter(n => n.selected).map(n => n.id));
    setNodes(nds => nds.filter(node => !node.selected));
    // Also drop edges left dangling by the removed nodes
    setEdges(eds => eds.filter(edge => !edge.selected && !removed.has(edge.source) && !removed.has(edge.target)));
  }, [getNodes, setNodes, setEdges]);

  const undo = useCallback(() => {
    if (!undoRef.current) return false;
    const { id, data } = undoRef.current;
    setNodes(nds => nds.map(node => 
      node.id === id ? { ...node, data } : node
    ));
    undoRef.current = null; // Can only undo once
    setHasUndo(false);
    return true;
  }, [setNodes]);

  // Shrink the selected node to its content: as narrow as it can be without adding lines
  // or cutting letters off, and only as tall as its content
  const fitSelectedNode = useCallback(() => {
    const node = getNodes().find(n => n.selected);
    if (!node || node.data.isCollapsed === 'true' || node.data.isCollapsed === true) return;
    const nodeEl = nodeElement(node.id);
    const width = nodeEl && fittedWidth(nodeEl);
    if (!width) return;
    rememberForUndo(node);
    setNodes(nds => nds.map(n => {
      if (n.id !== node.id) return n;
      const data: Record<string, unknown> = { ...n.data, width };
      delete data.height;
      return { ...n, data };
    }));
  }, [getNodes, setNodes, rememberForUndo]);

  // Keyboard shortcuts (also work from an iPad with a hardware keyboard)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Never treat typing in a field as a shortcut
      if (drawNodeId) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable) return;

      if (['1', '2', '3', '4'].includes(e.key)) {
        if (e.key === '4') toggleMainTitle();
        if (e.key === '1') applyColor('#ef4444'); // red
        if (e.key === '2') applyColor('#3b82f6'); // blue
        if (e.key === '3') applyColor('#10b981'); // green
      }
      
      if (['r', 'R', 'q', 'Q'].includes(e.key)) {
        summarizeSelected((e.key === 'q' || e.key === 'Q') ? 'short' : 'normal');
      }
      
      // e.code so it also works on a Hebrew keyboard layout
      if (e.code === 'KeyT' && !e.ctrlKey && !e.metaKey && !e.altKey) generateLinkedNode('example');
      if (e.code === 'KeyY' && !e.ctrlKey && !e.metaKey && !e.altKey) generateLinkedNode('simple');
      // On a Simplify node: [ simpler, ] more precise
      if (e.code === 'BracketLeft' && !e.ctrlKey && !e.metaKey && !e.altKey) changeSimpleLevel(-1);
      if (e.code === 'BracketRight' && !e.ctrlKey && !e.metaKey && !e.altKey) changeSimpleLevel(1);

      if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey && !e.altKey) fitSelectedNode();

      if (e.code === 'KeyO' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const selectedNode = getNodes().find(n => n.selected);
        if (selectedNode) runOcr(selectedNode.id);
      }

      if (['Delete', 'Backspace'].includes(e.key)) {
        deleteSelection();
      }

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-'].includes(e.key)) {
        const selectedNodeEl = document.querySelector('.react-flow__node.selected') as HTMLElement;
        if (selectedNodeEl) {
          e.preventDefault();
          e.stopPropagation();
          setNodes(nds => {
            return nds.map(node => {
              if (node.selected) {
                const currentWidth = Number(node.data.width || selectedNodeEl.offsetWidth || 260);
                const currentHeight = Number(node.data.height || selectedNodeEl.offsetHeight || 150);
                const nodeEl = nodeElement(node.id);
                let newWidth = currentWidth;
                let newHeight = currentHeight;
                
                if (e.key === 'ArrowRight') newWidth += 20;
                if (e.key === 'ArrowLeft') newWidth = Math.max(100, newWidth - 20);
                if (e.key === 'ArrowDown') newHeight += 20;
                if (e.key === 'ArrowUp') newHeight = Math.max(20, newHeight - 20);
                
                if (e.key === '+' || e.key === '=') {
                  newWidth += 20;
                  newHeight += 20;
                }
                if (e.key === '-') {
                  newWidth = Math.max(100, newWidth - 20);
                  newHeight = Math.max(20, newHeight - 20);
                }
                
                return { ...node, data: resizedData(node.data, newWidth, newHeight, nodeEl) };
              }
              return node;
            });
          });
        }
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (undo()) e.preventDefault();
      }

      if (e.key === 'Escape') setConnectFrom(null);
    };
    
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [setNodes, getNodes, runOcr, toggleMainTitle, applyColor, summarizeSelected, generateLinkedNode, changeSimpleLevel, deleteSelection, undo, drawNodeId, fitSelectedNode]);

  // Turn pasted content (text and/or an image) or an image picked from Photos/Files/the camera
  // into a node at the screen center
  const addPastedNode = useCallback(({ text, image }: { text?: string, image?: Blob }) => {
    text = text?.trim();
    if (!text && !image) return;
    const firstLine = text?.split('\n')[0].trim();
    const label = firstLine ? (firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine) : 'Pasted Image';

    const addNode = (data: Record<string, unknown>) => {
      const centerPosition = screenToFlowPosition({ 
        x: window.innerWidth / 2, 
        y: window.innerHeight / 2 
      });
      const newNode: Node = {
        id: `node-${Date.now()}`,
        position: centerPosition,
        data: { label, color: '#8b5cf6', ...(text ? { content: text } : {}), ...data },
        type: 'study',
        // A new node comes in selected, so its toolbar (OCR, colors, summarize) is ready
        selected: true
      };
      setNodes((nds) => [...nds.map(n => n.selected ? { ...n, selected: false } : n), newNode]);
    };

    if (!image) {
      addNode({ width: 300 });
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target && typeof event.target.result === 'string') {
        const base64 = event.target.result;
        const img = new window.Image();
        img.onload = () => {
          addNode({
            image: base64,
            width: Math.max(260, img.width),
            // With text under the image, let the node grow to fit it
            ...(text ? {} : { height: Math.max(80, img.height + 36) })
          });
        };
        img.src = base64;
      }
    };
    reader.readAsDataURL(image);
  }, [setNodes, screenToFlowPosition]);

  const addImageNode = useCallback((blob: Blob) => addPastedNode({ image: blob }), [addPastedNode]);

  // The text and first image of a paste event
  const readPasteEvent = (clipboardData: DataTransfer) => {
    let image: Blob | undefined;
    for (let i = 0; i < clipboardData.items.length; i++) {
      if (clipboardData.items[i].type.indexOf('image') !== -1) {
        image = clipboardData.items[i].getAsFile() ?? undefined;
        if (image) break;
      }
    }
    return { text: clipboardData.getData('text/plain'), image };
  };

  // Pasting (Cmd/Ctrl+V) on the canvas; pasting into a text field stays a normal paste
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return;
      addPastedNode(readPasteEvent(e.clipboardData));
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [addPastedNode]);

  // Paste button for touch (no Cmd+V without a keyboard): text and/or an image into a new node.
  // The async clipboard API only exists on HTTPS / localhost; over plain http (the iPad on the LAN)
  // it falls back to a paste box, where the system Paste menu delivers a normal paste event.
  const openPasteBox = useCallback(() => {
    // iOS only shows the keyboard (and its Paste key) if focus() happens synchronously inside the tap
    flushSync(() => setIsPasteBoxOpen(true));
    pasteBoxRef.current?.focus();
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    if (!navigator.clipboard?.read) {
      openPasteBox();
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      let text = '';
      let image: Blob | undefined;
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType && !image) image = await item.getType(imageType);
        if (item.types.includes('text/plain')) {
          const part = (await (await item.getType('text/plain')).text()).trim();
          if (part) text += (text ? '\n\n' : '') + part;
        }
      }
      if (!text && !image) {
        alert('Nothing to paste: the clipboard has no text or image.');
        return;
      }
      addPastedNode({ text, image });
    } catch (err) {
      // NotAllowedError is normal on iPad when the system "Paste" bubble is dismissed or access is
      // refused, so it's a warning (console.error would raise the Next.js error overlay)
      console.warn('Clipboard read failed, using the paste box:', err);
      openPasteBox();
    }
  }, [addPastedNode, openPasteBox]);

  // Mouse drag logic (Right click connect, Middle click resize)
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.button === 2) { // Right click
        const nodeEl = (e.target as HTMLElement).closest('.react-flow__node');
        if (nodeEl) {
          const sourceId = nodeEl.getAttribute('data-id')!;
          dragState.current = { type: 'right', sourceId };
          setConnectLine({ startX: e.clientX, startY: e.clientY, currentX: e.clientX, currentY: e.clientY });
        }
      } else if (e.button === 1) { // Middle click
        const nodeEl = (e.target as HTMLElement).closest('.react-flow__node') as HTMLElement;
        if (nodeEl) {
          e.preventDefault();
          const sourceId = nodeEl.getAttribute('data-id')!;
          const currentWidth = nodeEl.offsetWidth || 260;
          const currentHeight = nodeEl.offsetHeight || 150;
          dragState.current = { type: 'middle', sourceId, startWidth: currentWidth, startHeight: currentHeight, startX: e.clientX, startY: e.clientY };
        }
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return;
      
      if (dragState.current.type === 'right') {
        setConnectLine(prev => prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null);
      } else if (dragState.current.type === 'middle') {
        const state = dragState.current;
        const dx = e.clientX - state.startX!;
        const dy = e.clientY - state.startY!;
        const zoom = getZoom();
        
        const newWidth = Math.max(100, state.startWidth! + dx / zoom);
        const newHeight = Math.max(20, state.startHeight! + dy / zoom);
        const nodeEl = nodeElement(state.sourceId);
        
        setNodes(nds => nds.map(n => n.id === state.sourceId ? { ...n, data: resizedData(n.data, newWidth, newHeight, nodeEl) } : n));
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!dragState.current) return;

      if (e.button === 2 && dragState.current.type === 'right') {
        const target = (e.target as HTMLElement).closest('.react-flow__node');
        if (target) {
          const targetId = target.getAttribute('data-id');
          const sourceId = dragState.current.sourceId;
          if (targetId && targetId !== sourceId) {
            setEdges(eds => addEdge({ 
              id: `edge-${Date.now()}`, 
              source: sourceId, 
              target: targetId,
              animated: false,
              markerEnd: { type: MarkerType.ArrowClosed }
            }, eds));
          }
        }
      }
      
      if (e.button === 2 || e.button === 1) {
        dragState.current = null;
        setConnectLine(null);
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault(); // Disable context menu completely everywhere
    };

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('contextmenu', onContextMenu);
    
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('contextmenu', onContextMenu);
    };
  }, [setEdges, setNodes, getZoom]);

  // Apple Pencil: drag from node A to node B to connect them (a finger drag still moves the node)
  useEffect(() => {
    let pen: { pointerId: number, sourceId: string, startX: number, startY: number, moved: boolean } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'pen') {
        // A pen gesture whose lift Safari never delivered must not outlive the next finger touch
        if (pen && e.pointerType === 'touch') { pen = null; setConnectLine(null); }
        return;
      }
      const el = e.target as HTMLElement;
      // Leave editing fields, the resize grip and node buttons to the pen as usual
      if (el.closest('input, textarea, button, .nodrag')) return;
      const nodeEl = el.closest('.react-flow__node');
      if (!nodeEl) return;
      pen = { pointerId: e.pointerId, sourceId: nodeEl.getAttribute('data-id')!, startX: e.clientX, startY: e.clientY, moved: false };
    };

    // Pointer events fire before the touch events React Flow drags nodes with, so swallowing the
    // pen's touchstart stops the node drag. Taps still select the node through the click that follows.
    // Only the pencil's own touches are swallowed (iOS marks them 'stylus'), never a finger's.
    const onTouchStart = (e: TouchEvent) => {
      if (!pen) return;
      const touches = Array.from(e.changedTouches) as (Touch & { touchType?: string })[];
      if (touches.every(t => t.touchType === 'stylus')) e.stopPropagation();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pen || e.pointerId !== pen.pointerId) return;
      if (!pen.moved && Math.hypot(e.clientX - pen.startX, e.clientY - pen.startY) < 10) return;
      pen.moved = true;
      setConnectLine({ startX: pen.startX, startY: pen.startY, currentX: e.clientX, currentY: e.clientY });
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!pen || e.pointerId !== pen.pointerId) return;
      const { sourceId, moved } = pen;
      pen = null;
      setConnectLine(null);
      if (!moved || e.type === 'pointercancel') return;
      // The pen's events stay targeted at the source node, so look up what's under the tip
      const targetId = document.elementFromPoint(e.clientX, e.clientY)?.closest('.react-flow__node')?.getAttribute('data-id');
      if (targetId && targetId !== sourceId) {
        setEdges(eds => addEdge({
          id: `edge-${Date.now()}`,
          source: sourceId,
          target: targetId,
          animated: false,
          markerEnd: { type: MarkerType.ArrowClosed }
        }, eds));
      }
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('touchstart', onTouchStart, true);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [setEdges]);

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge({ ...params, animated: false, markerEnd: { type: MarkerType.ArrowClosed } }, eds)),
    [setEdges]
  );

  // Touch connect mode: tap "Connect" on the source, then tap the target node
  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (!connectFrom || node.id === connectFrom) return;
      setEdges(eds => addEdge({
        id: `edge-${Date.now()}`,
        source: connectFrom,
        target: node.id,
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed }
      }, eds));
      setConnectFrom(null);
    },
    [connectFrom, setEdges]
  );

  // The pane element also wraps the nodes and edges, so rule those out
  const isEmptyCanvas = (target: EventTarget) => {
    const el = target as HTMLElement;
    return !!el.closest('.react-flow__pane') && !el.closest('.react-flow__node, .react-flow__edge');
  };

  const addNodeAt = useCallback(
    (clientX: number, clientY: number) => {
      const position = screenToFlowPosition({ x: clientX, y: clientY });
      const newNode: Node = {
        id: `node-${Date.now()}`,
        position,
        data: { label: 'New Topic', color: '#10b981', width: 260, autoEdit: true },
        type: 'study',
        // A new node comes in selected, so its toolbar is ready
        selected: true
      };
      setNodes((nds) => [...nds.map(n => n.selected ? { ...n, selected: false } : n), newNode]);
    },
    [setNodes, screenToFlowPosition]
  );

  const onPaneDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      // Only on the empty canvas (not on panels/buttons), and not again right after a touch double-tap
      if (!isEmptyCanvas(e.target)) return;
      if (Date.now() - lastTouchAdd.current < 800) return;
      addNodeAt(e.clientX, e.clientY);
    },
    [addNodeAt]
  );

  // Double-tap on the empty canvas (finger or Apple Pencil) adds a node, like double-click does
  const onPanePointerDown = useCallback((e: React.PointerEvent) => {
    paneTap.current.downX = e.clientX;
    paneTap.current.downY = e.clientY;
  }, []);

  const onPanePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' || !isEmptyCanvas(e.target)) return;
      const t = paneTap.current;
      if (Math.hypot(e.clientX - t.downX, e.clientY - t.downY) > 10) { // a pan, not a tap
        t.lastTime = 0;
        return;
      }
      const now = Date.now();
      if (now - t.lastTime < 350 && Math.hypot(e.clientX - t.lastX, e.clientY - t.lastY) < 30) {
        t.lastTime = 0;
        lastTouchAdd.current = now;
        addNodeAt(e.clientX, e.clientY);
      } else {
        t.lastTime = now;
        t.lastX = e.clientX;
        t.lastY = e.clientY;
      }
    },
    [addNodeAt]
  );

  const addNodeAtCenter = useCallback(() => {
    const pane = document.querySelector('.react-flow__pane')?.getBoundingClientRect();
    if (!pane) return;
    addNodeAt(pane.left + pane.width / 2 - 130, pane.top + pane.height / 2 - 65);
  }, [addNodeAt]);

  // iPad: tapping the empty canvas or another node doesn't blur a node's text field, it only changes
  // the selection. Blur it then, which saves the edit through the node's onBlur.
  const onSelectionChange = useCallback(({ nodes: selected }: { nodes: Node[] }) => {
    const active = document.activeElement as HTMLElement | null;
    const editingNodeId = active?.closest('.react-flow__node')?.getAttribute('data-id');
    if (editingNodeId && !selected.some(n => n.id === editingNodeId)) active!.blur();
  }, []);

  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      e.preventDefault();
      setEdges((eds) => eds.filter((edg) => edg.id !== edge.id));
    },
    [setEdges]
  );

  const onLayout = useCallback(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(nodes, edges);
    setNodes([...layoutedNodes]);
    setEdges([...layoutedEdges]);
    setTimeout(() => fitView({ duration: 800, padding: 0.2 }), 50);
  }, [nodes, edges, setNodes, setEdges, fitView]);

  if (loading) {
    return <div className="loading">Loading Mind Map...</div>;
  }

  const selectedNode = nodes.find(n => n.selected);
  const hasSelectedEdge = edges.some(e => e.selected);
  const showSelectionToolbar = !connectFrom && (selectedNode || hasSelectedEdge);

  return (
    <div
      className={showSelectionToolbar ? 'has-selection' : undefined}
      style={{ width: '100%', height: '100%' }}
      onDoubleClick={onPaneDoubleClick}
      onPointerDown={onPanePointerDown}
      onPointerUp={onPanePointerUp}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onSelectionChange={onSelectionChange}
        onEdgeContextMenu={onEdgeContextMenu}
        zoomOnDoubleClick={false}
        // Touch: bigger hit area for the connection handles and for tapping edges
        connectionRadius={40}
        colorMode="dark"
        defaultEdgeOptions={{ 
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { strokeWidth: 3 },
          interactionWidth: 30
        }}
        fitView
      >
        <Controls showInteractive={false} />
        <MiniMap 
          zoomable 
          pannable 
          nodeColor="#3b82f6" 
          maskColor="rgba(15, 23, 42, 0.8)" 
          style={{ backgroundColor: '#1e293b' }} 
        />
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#334155" />

        {/* Creating things: the touch replacements for double-click and Cmd+V */}
        <Panel position="top-left" style={{ display: 'flex', gap: '10px', marginLeft: 'max(15px, env(safe-area-inset-left))' }}>
          <button className="add-button" onClick={addNodeAtCenter} style={{ background: '#10b981' }} title="Add a node (or double-tap the canvas)">
            <Plus size={20} />
            <span className="button-label">Node</span>
          </button>
          <button className="add-button" onClick={() => imageInputRef.current?.click()} style={{ background: '#475569' }} title="Add an image from Photos, Files or the camera">
            <ImagePlus size={20} />
            <span className="button-label">Image</span>
          </button>
          <button className="add-button" onClick={pasteFromClipboard} style={{ background: '#475569' }} title="Paste content (text and images) from the clipboard into a new node">
            <ClipboardPaste size={20} />
            <span className="button-label">Paste content</span>
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) addImageNode(file);
              e.target.value = ''; // allow picking the same file again
            }}
          />
        </Panel>
        
        <Panel position="top-right" style={{ display: 'flex', gap: '10px', marginRight: 'max(15px, env(safe-area-inset-right))' }}>
          <div style={{ position: 'relative' }}>
            <button className="add-button" onClick={() => setIsSettingsOpen(!isSettingsOpen)} style={{ background: '#475569' }} title="Config">
              <Settings size={20} />
              <span className="button-label">Config</span>
            </button>
            {isSettingsOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: '8px', background: '#1e293b', padding: '12px', borderRadius: '8px', border: '1px solid #334155', boxShadow: '0 4px 6px rgba(0,0,0,0.3)', width: 'min(340px, calc(100vw - 32px))', boxSizing: 'border-box', zIndex: 50 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                      <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>Max Words (Q)</label>
                      <input 
                        type="number" 
                        inputMode="numeric"
                        value={maxWordsQ} 
                        onChange={(e) => setMaxWordsQ(Number(e.target.value))}
                        style={{ background: '#0f172a', color: 'white', border: '1px solid #334155', borderRadius: '4px', padding: '6px', width: '100%', boxSizing: 'border-box' }}
                      />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                      <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>Max Words (R)</label>
                      <input 
                        type="number" 
                        inputMode="numeric"
                        value={maxWordsR} 
                        onChange={(e) => setMaxWordsR(Number(e.target.value))}
                        style={{ background: '#0f172a', color: 'white', border: '1px solid #334155', borderRadius: '4px', padding: '6px', width: '100%', boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>Model</label>
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      style={{ background: '#0f172a', color: 'white', border: '1px solid #334155', borderRadius: '4px', padding: '6px', width: '100%', boxSizing: 'border-box' }}
                    >
                      <option value="">Default{defaultModel ? ` (${defaultModel})` : ''}</option>
                      {WORKING_MODELS.map(m => (
                        <option key={m.id} value={m.id}>{m.name} (~{m.seconds}s)</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ color: '#cbd5e1', fontSize: '12px', fontWeight: 'bold' }}>System Prompt</label>
                    <textarea 
                      value={systemPrompt} 
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      style={{ background: '#0f172a', color: 'white', border: '1px solid #334155', borderRadius: '4px', padding: '6px', height: '150px', resize: 'vertical', fontSize: '11px', fontFamily: 'monospace' }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
          <button className="add-button" onClick={() => setIsDefinitionsOpen(!isDefinitionsOpen)} style={{ background: '#3b82f6' }} title="Definitions">
            <BookOpen size={20} />
            <span className="button-label">Definitions</span>
          </button>
          <button className="add-button" onClick={onLayout} style={{ background: '#8b5cf6' }} title="Organize Layout">
            <LayoutTemplate size={20} />
            <span className="button-label">Organize Layout</span>
          </button>
        </Panel>

        {connectFrom && (
          <Panel position="bottom-center">
            <div className="connect-banner">
              <Link2 size={18} />
              <span>Tap the node to connect to</span>
              <button className="tool-button" onClick={() => setConnectFrom(null)} style={{ color: 'white' }} title="Cancel (Esc)">
                <X size={18} />
              </button>
            </div>
          </Panel>
        )}

        {/* Everything the keyboard shortcuts do, as buttons, for the selected node or edge */}
        {showSelectionToolbar && (
          <Panel position="bottom-center">
            <div className="selection-toolbar">
              {selectedNode && (
                <>
                  <button className="tool-button" title="Edit (double-tap)" onClick={() => window.dispatchEvent(new CustomEvent('edit-node', { detail: selectedNode.id }))}>
                    <Pencil size={18} />
                  </button>
                  <div className="divider" />
                  <button className="tool-button" title="Red + short definition (1)" onClick={() => applyColor('#ef4444')}>
                    <span className="color-swatch" style={{ background: '#ef4444' }} />
                  </button>
                  <button className="tool-button" title="Blue + short definition (2)" onClick={() => applyColor('#3b82f6')}>
                    <span className="color-swatch" style={{ background: '#3b82f6' }} />
                  </button>
                  <button className="tool-button" title="Green + short definition (3)" onClick={() => applyColor('#10b981')}>
                    <span className="color-swatch" style={{ background: '#10b981' }} />
                  </button>
                  <button className={`tool-button${selectedNode.data.isMainTitle ? ' active' : ''}`} title="Main title (4)" onClick={toggleMainTitle}>
                    <Crown size={18} />
                  </button>
                  <button className="tool-button" title={selectedNode.data.dir === 'rtl' ? 'Text is right-to-left; switch to left-to-right' : 'Switch text to right-to-left'} onClick={toggleTextDirection}>
                    {selectedNode.data.dir === 'rtl' ? <PilcrowLeft size={18} /> : <PilcrowRight size={18} />}
                  </button>
                  <button
                    className="tool-button"
                    title={`Font: ${nodeFont(selectedNode.data.font)?.label ?? 'Standard'} (tap for the next one)`}
                    onClick={cycleNodeFont}
                  >
                    <span style={{ fontFamily: nodeFont(selectedNode.data.font)?.family, fontSize: '17px', lineHeight: 1 }}>אב</span>
                    <span className="tool-label">{nodeFont(selectedNode.data.font)?.label ?? 'Standard'}</span>
                  </button>
                  <button className="tool-button" title="Fit: shrink the node to its content (H)" onClick={fitSelectedNode}>
                    <Shrink size={18} />
                  </button>
                  <div className="divider" />
                  <button className="tool-button" title="Summarize (R)" disabled={!!selectedNode.data.isGenerating} onClick={() => summarizeSelected('normal')}>
                    <Sparkles size={18} />
                    <span className="tool-label">Summarize</span>
                  </button>
                  <button className="tool-button" title="Short summary (Q)" disabled={!!selectedNode.data.isGenerating} onClick={() => summarizeSelected('short')}>
                    <Zap size={18} />
                    <span className="tool-label">Short</span>
                  </button>
                  <button className="tool-button" title="Example: a new linked node with an example of this term (T)" disabled={!!selectedNode.data.isGenerating} onClick={() => generateLinkedNode('example')}>
                    <Lightbulb size={18} />
                    <span className="tool-label">Example</span>
                  </button>
                  <button className="tool-button" title="Simplify: a new linked node explaining this topic informally, as simply as possible (Y)" disabled={!!selectedNode.data.isGenerating} onClick={() => generateLinkedNode('simple')}>
                    <Baby size={18} />
                    <span className="tool-label">Simplify</span>
                  </button>
                  {(!!selectedNode.data.simpleLevel || !!selectedNode.data.content) && (() => {
                    // Matches changeSimpleLevel: 0 means the node has no level and is rewritten relative to its text
                    const level = Number(selectedNode.data.simpleLevel) || (selectedNode.data.color === '#f59e0b' ? 1 : 0);
                    return (
                      <>
                        <button className="tool-button" title="Simpler: rewrite this node in plainer words ([)" disabled={!!selectedNode.data.isGenerating || level === 1} onClick={() => changeSimpleLevel(-1)}>
                          <Minus size={18} />
                          <span className="tool-label">Simpler</span>
                        </button>
                        <button className="tool-button" title="More precise: rewrite this node with more accurate terms (])" disabled={!!selectedNode.data.isGenerating || level >= SIMPLE_MAX_LEVEL} onClick={() => changeSimpleLevel(1)}>
                          <GraduationCap size={18} />
                          <span className="tool-label">{level ? `Precise ${level}/${SIMPLE_MAX_LEVEL}` : 'Precise'}</span>
                        </button>
                      </>
                    );
                  })()}
                  <button className="tool-button" title="Free draw with the pencil in this node" disabled={!!selectedNode.data.isGenerating} onClick={() => setDrawNodeId(selectedNode.id)}>
                    <Brush size={18} />
                    <span className="tool-label">Draw</span>
                  </button>
                  {!!selectedNode.data.image && (
                    <button className="tool-button" title="OCR: exact text from the image (O)" disabled={!!selectedNode.data.isGenerating} onClick={() => runOcr(selectedNode.id)}>
                      <ScanText size={18} />
                      <span className="tool-label">OCR</span>
                    </button>
                  )}
                  <div className="divider" />
                  <button className="tool-button" title="Connect to another node (or right-drag, or drag with Apple Pencil)" onClick={() => setConnectFrom(selectedNode.id)}>
                    <Link2 size={18} />
                  </button>
                </>
              )}
              <button className="tool-button" title="Undo (Ctrl/Cmd+Z)" disabled={!hasUndo} onClick={undo}>
                <Undo2 size={18} />
              </button>
              <button className="tool-button" title="Delete (Delete key)" onClick={deleteSelection} style={{ color: '#f87171' }}>
                <Trash2 size={18} />
              </button>
            </div>
          </Panel>
        )}
      </ReactFlow>
      
      {isDefinitionsOpen && (
        <DefinitionsPanel 
          nodes={nodes} 
          onClose={() => setIsDefinitionsOpen(false)} 
          onNodeClick={handleDefinitionClick}
        />
      )}
      
      {isPasteBoxOpen && (
        <div className="paste-box-backdrop" onClick={() => setIsPasteBoxOpen(false)}>
          <div className="paste-box" onClick={(e) => e.stopPropagation()}>
            <div className="paste-box-header">
              <ClipboardPaste size={18} />
              <span>Tap the box, then Paste</span>
              <button className="tool-button" onClick={() => setIsPasteBoxOpen(false)} style={{ color: 'white', marginLeft: 'auto' }} title="Cancel">
                <X size={18} />
              </button>
            </div>
            <div
              ref={pasteBoxRef}
              className="paste-box-target"
              contentEditable
              suppressContentEditableWarning
              onPaste={(e) => {
                e.preventDefault();
                addPastedNode(readPasteEvent(e.clipboardData));
                setIsPasteBoxOpen(false);
              }}
              // Only pasting goes in here, not typing
              onBeforeInput={(e) => e.preventDefault()}
            />
          </div>
        </div>
      )}

      {drawNodeId && (() => {
        const data = getNodes().find(n => n.id === drawNodeId)?.data;
        const image = data?.image as string | undefined;
        // Its live strokes, unless the image has since been replaced (then draw over the new one)
        const drawing = data?.drawing as SavedDrawing | undefined;
        return <DrawPad
          image={image}
          drawing={drawing && drawing.image === image ? drawing : undefined}
          onSave={saveDrawing}
          onClose={() => setDrawNodeId(null)}
        />;
      })()}

      {/* Right Click Drag Line Overlay */}
      {connectLine && (
        <svg style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 1000 }}>
          <line 
            x1={connectLine.startX} 
            y1={connectLine.startY} 
            x2={connectLine.currentX} 
            y2={connectLine.currentY} 
            stroke="#8b5cf6" 
            strokeWidth={3}
            strokeDasharray="6,6" 
          />
        </svg>
      )}
    </div>
  );
}

export default function MindMap({ courseName }: { courseName: string }) {
  return (
    <ReactFlowProvider>
      <Flow courseName={courseName} />
    </ReactFlowProvider>
  );
}
