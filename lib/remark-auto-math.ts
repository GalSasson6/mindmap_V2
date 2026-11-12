function visit(node: any, type: string, visitor: (node: any, index: number, parent: any) => number | void) {
  if (!node) return;
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === type) {
        const nextIndex = visitor(child, i, node);
        if (typeof nextIndex === 'number') {
          i = nextIndex - 1;
        }
      } else {
        visit(child, type, visitor);
      }
    }
  }
}

export default function remarkAutoMath() {
  return (tree: any) => {
    visit(tree, 'text', (node, index, parent) => {
      // Match patterns like x^2, x_a, x_{a}, mass_1
      const regex = /\b([a-zA-Z][a-zA-Z0-9]*[\^_](?:\{[a-zA-Z0-9]+\}|[a-zA-Z0-9]+))/g;
      const text = node.value;
      if (!regex.test(text)) return;
      
      regex.lastIndex = 0;
      let match;
      const newNodes = [];
      let lastIndex = 0;
      
      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          newNodes.push({ type: 'text', value: text.slice(lastIndex, match.index) });
        }
        newNodes.push({ 
          type: 'inlineMath', 
          value: match[1],
          data: {
            hName: 'span',
            hProperties: { className: ['math', 'math-inline'] },
            hChildren: [{ type: 'text', value: match[1] }]
          }
        });
        lastIndex = regex.lastIndex;
      }
      
      if (lastIndex < text.length) {
        newNodes.push({ type: 'text', value: text.slice(lastIndex) });
      }
      
      parent.children.splice(index, 1, ...newNodes);
      return index + newNodes.length;
    });
  };
}
