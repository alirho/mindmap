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
        this.scale = 1;
        this.pan = { x: 0, y: 0 };

        this.dragState = {
            isDraggingNode: false,
            nodeId: null,
            lastMousePos: { x: 0, y: 0 }
        };
        this.panState = {
            isPanning: false,
            lastMousePos: { x: 0, y: 0 }
        };

        this.init();
    }

    init() {
        this.createRootNode();
        this.bindEventListeners();
        this.updateAddNodeButton();
        this.updateTransform();
    }

    createRootNode() {
        // Center the root node initially
        const rootNodeId = this.createNode('موضوع اصلی', null, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
        this.selectNode(rootNodeId);
    }
    
    bindEventListeners() {
        // --- Pan Listeners ---
        this.canvas.addEventListener('mousedown', this.handlePanStart.bind(this));
        
        // --- Drag and Pan Listeners on document for better UX ---
        document.addEventListener('mousemove', this.handleMouseMove.bind(this));
        document.addEventListener('mouseup', this.handleMouseUp.bind(this));

        // --- Zoom Listener ---
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));

        // --- Other Listeners ---
        this.addNodeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.addNode();
        });
        document.addEventListener('keydown', this.handleKeyDown.bind(this));
    }
    
    updateTransform() {
        const transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.scale})`;
        this.nodesLayer.style.transform = transform;
        this.svgLayer.style.transform = transform;
    }
    
    // --- Node Management ---

    createNode(text, parentId, position) {
        const id = parentId === null ? ROOT_NODE_ID : `node_${Date.now()}`;
        
        this.nodes[id] = {
            id,
            text,
            parentId,
            childrenIds: [],
            position,
            element: null, // Will be set by renderNodeDOM
            isCollapsed: false,
        };
        
        const nodeEl = this.renderNodeDOM(id, text, position);
        this.nodes[id].element = nodeEl;

        if (parentId && this.nodes[parentId]) {
            this.nodes[parentId].childrenIds.push(id);
        }

        return id;
    }

    deleteNode(nodeId) {
        if (!nodeId || nodeId === ROOT_NODE_ID) return;

        const allIdsToDelete = [nodeId, ...this.getAllDescendantIds(nodeId)];
        const nodeToDelete = this.nodes[nodeId];

        allIdsToDelete.forEach(id => {
            const node = this.nodes[id];
            if (node && node.element) {
                node.element.remove();
            }
            delete this.nodes[id];
        });

        if (nodeToDelete.parentId && this.nodes[nodeToDelete.parentId]) {
            const parent = this.nodes[nodeToDelete.parentId];
            parent.childrenIds = parent.childrenIds.filter(childId => childId !== nodeId);
        }

        if (allIdsToDelete.includes(this.selectedNodeId)) {
            this.selectNode(nodeToDelete.parentId || null);
        }

        this.updateUIVisibilityAndConnectors();
    }
    
    addNode() {
        if (!this.selectedNodeId) return;

        const parentNode = this.nodes[this.selectedNodeId];
        if (!parentNode) return;

        const offsetX = 250;
        const baseOffsetY = 80;
        const siblingOffsetY = 120;
        let newPosition;

        if (parentNode.id === ROOT_NODE_ID) {
            const childrenOnLeft = parentNode.childrenIds.filter(id => this.nodes[id].position.x < parentNode.position.x).length;
            const childrenOnRight = parentNode.childrenIds.filter(id => this.nodes[id].position.x > parentNode.position.x).length;

            const addOnLeft = childrenOnLeft <= childrenOnRight;
            
            const direction = addOnLeft ? -1 : 1;
            const countOnSide = addOnLeft ? childrenOnLeft : childrenOnRight;
            const offsetY = (countOnSide % 2 === 0 ? 1 : -1) * (Math.floor(countOnSide / 2) * siblingOffsetY + baseOffsetY);

            newPosition = {
                x: parentNode.position.x + (direction * offsetX),
                y: parentNode.position.y + offsetY
            };
        } else {
            const rootNode = this.nodes[ROOT_NODE_ID];
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
        this.updateUIVisibilityAndConnectors();
    }
    
    toggleCollapse(nodeId) {
        const node = this.nodes[nodeId];
        if (!node || node.childrenIds.length === 0) {
            return;
        }

        node.isCollapsed = !node.isCollapsed;

        // If collapsing, and the selected node is a descendant, select the collapsing node.
        if (node.isCollapsed) {
            const descendantIds = this.getAllDescendantIds(nodeId);
            if (descendantIds.includes(this.selectedNodeId)) {
                this.selectNode(nodeId);
            }
        }

        this.updateUIVisibilityAndConnectors();
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

        nodeEl.addEventListener('mousedown', (e) => { e.stopPropagation(); this.handleDragStart(e, nodeId); });
        nodeEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.makeNodeEditable(nodeId); });
        nodeEl.addEventListener('click', (e) => { e.stopPropagation(); this.selectNode(nodeId); });

        // Add collapse button
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'collapse-btn';
        collapseBtn.setAttribute('aria-label', 'جمع/باز کردن گره');
        collapseBtn.style.display = 'none'; // Initially hidden, shown by updateUIVisibility
        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCollapse(nodeId);
        });
        nodeEl.appendChild(collapseBtn);

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
        // Prevent selection of a hidden node
        if(nodeId && this.isAnyAncestorCollapsed(nodeId)) {
            return;
        }

        if (this.selectedNodeId && this.nodes[this.selectedNodeId]) {
            this.nodes[this.selectedNodeId].element.classList.remove('selected');
        }
        
        this.selectedNodeId = nodeId;

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
            e.stopPropagation(); // Prevent keyboard shortcuts while editing
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                input.value = nodeData.text;
                input.blur();
            }
        });
        
        nodeEl.replaceChild(input, textSpan);
        input.focus();
        input.select();
    }

    // --- Connectors and Visibility ---

    updateUIVisibilityAndConnectors() {
        this.svgLayer.innerHTML = ''; // Clear all connectors

        Object.values(this.nodes).forEach(node => {
            // 1. Update collapse button state and position
            const collapseBtn = node.element.querySelector('.collapse-btn');
            if (collapseBtn) {
                if (node.childrenIds.length > 0) {
                    collapseBtn.style.display = 'flex';
                    collapseBtn.textContent = node.isCollapsed ? '+' : '−';

                    const childPositionsX = node.childrenIds.map(id => this.nodes[id].position.x);
                    const allToTheRight = childPositionsX.every(x => x > node.position.x);
                    const allToTheLeft = childPositionsX.every(x => x < node.position.x);
                    
                    // Reset styles
                    Object.assign(collapseBtn.style, {
                        left: '', right: '', top: '', bottom: '', transform: ''
                    });

                    if (allToTheRight) {
                        collapseBtn.style.right = '-0.75rem';
                        collapseBtn.style.top = '50%';
                        collapseBtn.style.transform = 'translateY(-50%)';
                    } else if (allToTheLeft) {
                        collapseBtn.style.left = '-0.75rem';
                        collapseBtn.style.top = '50%';
                        collapseBtn.style.transform = 'translateY(-50%)';
                    } else {
                        // Default to bottom-center for mixed/vertical children (e.g., on root)
                        collapseBtn.style.left = '50%';
                        collapseBtn.style.bottom = '-0.75rem';
                        collapseBtn.style.transform = 'translateX(-50%)';
                    }
                } else {
                    collapseBtn.style.display = 'none';
                }
            }

            // 2. Update node visibility
            const isVisible = !this.isAnyAncestorCollapsed(node.id);
            node.element.style.display = isVisible ? 'flex' : 'none';

            // 3. Draw connector if visible and has a parent
            if (isVisible && node.parentId && this.nodes[node.parentId]) {
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
    
    // --- Mouse Event Handling ---

    handleDragStart(e, nodeId) {
        if (e.button !== 0) return;
        this.dragState = {
            isDraggingNode: true,
            nodeId: nodeId,
            lastMousePos: { x: e.clientX, y: e.clientY }
        };
    }

    handlePanStart(e) {
        // Only pan if not clicking on a node
        if (e.target.closest('.mindmap-node') || e.button !== 0) return;
        e.preventDefault();
        this.panState = {
            isPanning: true,
            lastMousePos: { x: e.clientX, y: e.clientY }
        };
        this.canvas.classList.add('panning');
    }
    
    handleMouseMove(e) {
        if (this.panState.isPanning) {
            const dx = e.clientX - this.panState.lastMousePos.x;
            const dy = e.clientY - this.panState.lastMousePos.y;
            this.pan.x += dx;
            this.pan.y += dy;
            this.updateTransform();
            this.panState.lastMousePos = { x: e.clientX, y: e.clientY };
        } else if (this.dragState.isDraggingNode) {
            // Adjust delta by scale to move node correctly at any zoom level
            const dx = (e.clientX - this.dragState.lastMousePos.x) / this.scale;
            const dy = (e.clientY - this.dragState.lastMousePos.y) / this.scale;
            this.moveNodeAndChildren(this.dragState.nodeId, { dx, dy });
            this.dragState.lastMousePos = { x: e.clientX, y: e.clientY };
        }
    }
    
    handleMouseUp() {
        if (this.panState.isPanning) {
            this.panState.isPanning = false;
            this.canvas.classList.remove('panning');
        }
        if (this.dragState.isDraggingNode) {
            this.dragState.isDraggingNode = false;
            this.dragState.nodeId = null;
        }
    }

    handleWheel(e) {
        e.preventDefault();
        const zoomFactor = 1.1;
        const oldScale = this.scale;
        
        if (e.deltaY < 0) {
            this.scale *= zoomFactor;
        } else {
            this.scale /= zoomFactor;
        }
        // Clamp scale to reasonable limits
        this.scale = Math.max(0.2, Math.min(this.scale, 4));

        const mousePoint = { x: e.clientX, y: e.clientY };
        
        // The point in world coords that should stay under the mouse
        const worldX = (mousePoint.x - this.pan.x) / oldScale;
        const worldY = (mousePoint.y - this.pan.y) / oldScale;

        // New pan to keep the world point under the mouse
        this.pan.x = mousePoint.x - worldX * this.scale;
        this.pan.y = mousePoint.y - worldY * this.scale;
        
        this.updateTransform();
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
        this.updateUIVisibilityAndConnectors();
    }
    
    // --- Keyboard Shortcuts ---

    handleKeyDown(e) {
        if (!this.selectedNodeId || document.activeElement.tagName === 'INPUT') {
            return;
        }

        switch (e.key) {
            case 'Tab':
                e.preventDefault();
                this.addNode();
                break;
            case 'F2':
                e.preventDefault();
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
        return node.childrenIds.flatMap(childId => [childId, ...this.getAllDescendantIds(childId)]);
    }

    isAnyAncestorCollapsed(nodeId) {
        let currentId = this.nodes[nodeId]?.parentId;
        while (currentId) {
            const currentNode = this.nodes[currentId];
            if (currentNode.isCollapsed) {
                return true;
            }
            currentId = currentNode.parentId;
        }
        return false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new MindMap('mindmap-canvas');
});