const ROOT_NODE_ID = 'root';

class MindMap {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.svgLayer = document.getElementById('mindmap-svg-layer');
        this.nodesLayer = document.getElementById('mindmap-nodes-layer');
        this.addNodeBtn = document.getElementById('add-node-btn');

        if (!this.canvas || !this.svgLayer || !this.nodesLayer || !this.addNodeBtn) {
            console.error('One or more required mind map elements are missing from the DOM.');
            return;
        }

        // State Management
        this.nodes = {};
        this.selectedNodeId = null;
        this.dragState = {
            isDragging: false,
            nodeId: null,
            lastMousePos: { x: 0, y: 0 }
        };

        this.init();
    }

    init() {
        this.createRootNode();
        this.bindEventListeners();
        this.updateAddNodeButton();
    }

    createRootNode() {
        const rootNodeId = this.createNode('موضوع اصلی', null, { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 });
        this.selectNode(rootNodeId);
    }
    
    bindEventListeners() {
        this.canvas.addEventListener('click', (e) => {
            if (e.target === this.canvas || e.target === this.nodesLayer) {
                this.selectNode(null);
            }
        });

        this.addNodeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addNode();
        });
        
        // Use document for mouse events to handle dragging outside the canvas gracefully
        document.addEventListener('mousemove', this.handleDragMove.bind(this));
        document.addEventListener('mouseup', this.handleDragEnd.bind(this));
        
        // Listen for global keydown events for shortcuts
        document.addEventListener('keydown', this.handleKeyDown.bind(this));
    }

    // --- Node Management ---

    createNode(text, parentId, position) {
        // The first node (with null parent) gets the fixed root ID
        const id = parentId === null ? ROOT_NODE_ID : `node_${Date.now()}`;
        const nodeEl = this.renderNodeDOM(id, text, position);

        this.nodes[id] = {
            id,
            text,
            parentId,
            childrenIds: [],
            position,
            element: nodeEl
        };

        if (parentId && this.nodes[parentId]) {
            this.nodes[parentId].childrenIds.push(id);
        }

        this.updateAllConnectors();
        return id;
    }

    deleteNode(nodeId) {
        // Prevent deleting the root node
        if (!nodeId || nodeId === ROOT_NODE_ID) return;

        const allIdsToDelete = [nodeId, ...this.getAllDescendantIds(nodeId)];
        const nodeToDelete = this.nodes[nodeId];

        // Remove DOM elements and data for the node and its descendants
        allIdsToDelete.forEach(id => {
            const node = this.nodes[id];
            if (node && node.element) {
                node.element.remove();
            }
            delete this.nodes[id];
        });

        // Remove the node from its parent's children array
        if (nodeToDelete.parentId && this.nodes[nodeToDelete.parentId]) {
            const parent = this.nodes[nodeToDelete.parentId];
            parent.childrenIds = parent.childrenIds.filter(childId => childId !== nodeId);
        }

        // If the selected node was deleted, select its parent
        if (allIdsToDelete.includes(this.selectedNodeId)) {
            this.selectNode(nodeToDelete.parentId || null);
        }

        this.updateAllConnectors();
    }
    
    addNode() {
        if (!this.selectedNodeId) return;

        const parentNode = this.nodes[this.selectedNodeId];
        if (!parentNode) return;

        const offsetX = 250;
        const baseOffsetY = 80;
        const siblingOffsetY = 120;
        let newPosition;

        // Special logic for the root node to balance children on both sides
        if (parentNode.id === ROOT_NODE_ID) {
            const childrenOnLeft = parentNode.childrenIds.filter(id => this.nodes[id].position.x < parentNode.position.x).length;
            const childrenOnRight = parentNode.childrenIds.filter(id => this.nodes[id].position.x > parentNode.position.x).length;

            const addOnLeft = childrenOnLeft <= childrenOnRight;
            
            const direction = addOnLeft ? -1 : 1; // -1 for left, 1 for right
            const countOnSide = addOnLeft ? childrenOnLeft : childrenOnRight;

            // Calculate vertical position to spread nodes out in a zig-zag pattern
            const offsetY = (countOnSide % 2 === 0 ? 1 : -1) * (Math.floor(countOnSide / 2) * siblingOffsetY + baseOffsetY);

            newPosition = {
                x: parentNode.position.x + (direction * offsetX),
                y: parentNode.position.y + offsetY
            };
        } else {
            // Logic for all other nodes: children spawn away from the center
            const rootNode = this.nodes[ROOT_NODE_ID];
            // Determine if the parent node is on the left or right of the root
            const direction = (parentNode.position.x < rootNode.position.x) ? -1 : 1;
            
            const childCount = parentNode.childrenIds.length;
            const offsetY = (childCount % 2 === 0 ? 1 : -1) * (Math.floor(childCount / 2) * siblingOffsetY + baseOffsetY);

            newPosition = {
                x: parentNode.position.x + (direction * offsetX),
                y: parentNode.position.y + offsetY
            };
        }
        
        const newNodeId = this.createNode('شاخه جدید', this.selectedNodeId, newPosition);
        this.selectNode(newNodeId);
    }
    
    // --- UI and Rendering ---
    
    renderNodeDOM(nodeId, text, position) {
        const nodeEl = document.createElement('div');
        nodeEl.id = `node-${nodeId}`;
        nodeEl.className = 'mindmap-node';
        nodeEl.style.left = `${position.x}px`;
        nodeEl.style.top = `${position.y}px`;

        const textSpan = document.createElement('span');
        textSpan.className = 'node-text';
        textSpan.textContent = text;
        nodeEl.appendChild(textSpan);

        // Bind events directly to the new DOM element
        nodeEl.addEventListener('click', (e) => { e.stopPropagation(); this.selectNode(nodeId); });
        nodeEl.addEventListener('mousedown', (e) => { e.stopPropagation(); this.handleDragStart(e, nodeId); });
        nodeEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.makeNodeEditable(nodeId); });

        // Add delete button only to non-root nodes
        if (nodeId !== ROOT_NODE_ID) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.innerHTML = '&times;';
            deleteBtn.setAttribute('aria-label', 'حذف گره');
            deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteNode(nodeId); });
            nodeEl.appendChild(deleteBtn);
        }

        this.nodesLayer.appendChild(nodeEl);
        return nodeEl;
    }

    updateNodePosition(nodeId, position) {
        const node = this.nodes[nodeId];
        if (node) {
            node.position = position;
            node.element.style.left = `${position.x}px`;
            node.element.style.top = `${position.y}px`;
        }
    }
    
    selectNode(nodeId) {
        // Deselect previous node
        if (this.selectedNodeId && this.nodes[this.selectedNodeId]) {
            this.nodes[this.selectedNodeId].element.classList.remove('selected');
        }
        
        this.selectedNodeId = nodeId;

        // Select new node
        if (this.selectedNodeId && this.nodes[this.selectedNodeId]) {
            this.nodes[this.selectedNodeId].element.classList.add('selected');
        }

        this.updateAddNodeButton();
    }

    updateAddNodeButton() {
        this.addNodeBtn.disabled = !this.selectedNodeId;
    }

    makeNodeEditable(nodeId) {
        const nodeData = this.nodes[nodeId];
        const nodeEl = nodeData.element;
        const textSpan = nodeEl.querySelector('.node-text');
        
        // Prevent editing if already in edit mode
        if (nodeEl.querySelector('.node-input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'node-input';
        input.value = nodeData.text;

        const saveChanges = () => {
            const newText = input.value.trim();
            if (newText) {
                nodeData.text = newText;
                textSpan.textContent = newText;
            }
            if (nodeEl.contains(input)) {
                nodeEl.replaceChild(textSpan, input);
            }
        };
        
        input.addEventListener('blur', saveChanges);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                input.value = nodeData.text; // Revert on escape
                input.blur();
            }
        });
        
        nodeEl.replaceChild(input, textSpan);
        input.focus();
        input.select();
    }

    // --- Connectors ---

    updateAllConnectors() {
        this.svgLayer.innerHTML = ''; // Clear all lines
        Object.values(this.nodes).forEach(node => {
            if (node.parentId && this.nodes[node.parentId]) {
                this.drawConnector(this.nodes[node.parentId].position, node.position);
            }
        });
    }

    drawConnector(fromPos, toPos) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', fromPos.x);
        line.setAttribute('y1', fromPos.y);
        line.setAttribute('x2', toPos.x);
        line.setAttribute('y2', toPos.y);
        line.setAttribute('class', 'connector-line');
        this.svgLayer.appendChild(line);
    }
    
    // --- Drag and Drop ---

    handleDragStart(e, nodeId) {
        if (e.button !== 0) return; // Only handle left-click drags
        this.selectNode(nodeId);
        
        this.dragState = {
            isDragging: true,
            nodeId: nodeId,
            lastMousePos: { x: e.clientX, y: e.clientY }
        };
    }
    
    handleDragMove(e) {
        if (!this.dragState.isDragging) return;
        
        const delta = {
            dx: e.clientX - this.dragState.lastMousePos.x,
            dy: e.clientY - this.dragState.lastMousePos.y,
        };

        this.moveNodeAndChildren(this.dragState.nodeId, delta);
        
        // Update last mouse position for the next move event
        this.dragState.lastMousePos = { x: e.clientX, y: e.clientY };
    }
    
    handleDragEnd() {
        this.dragState.isDragging = false;
        this.dragState.nodeId = null;
    }

    moveNodeAndChildren(rootNodeId, delta) {
        const idsToMove = [rootNodeId, ...this.getAllDescendantIds(rootNodeId)];
        idsToMove.forEach(id => {
            const node = this.nodes[id];
            if (node) {
                const newPosition = {
                    x: node.position.x + delta.dx,
                    y: node.position.y + delta.dy
                };
                this.updateNodePosition(id, newPosition);
            }
        });
        this.updateAllConnectors();
    }
    
    // --- Keyboard Shortcuts ---

    handleKeyDown(e) {
        // Do not trigger shortcuts if no node is selected or if we are editing text.
        if (!this.selectedNodeId || document.activeElement.tagName === 'INPUT') {
            return;
        }

        switch (e.key) {
            case 'Tab':
                e.preventDefault(); // Prevent default browser tabbing
                this.addNode();
                break;
            
            case 'F2':
                e.preventDefault(); // Prevent default browser actions for F2
                this.makeNodeEditable(this.selectedNodeId);
                break;
                
            case 'Delete':
                e.preventDefault();
                this.deleteNode(this.selectedNodeId);
                break;
        }
    }

    // --- Helpers ---
    
    getAllDescendantIds(nodeId) {
        const node = this.nodes[nodeId];
        if (!node || !node.childrenIds || node.childrenIds.length === 0) {
            return [];
        }
        // Recursively flatten the array of children and their descendants
        return node.childrenIds.flatMap(childId => [childId, ...this.getAllDescendantIds(childId)]);
    }
}

// Initialize the application once the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    new MindMap('mindmap-canvas');
});