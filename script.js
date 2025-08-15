const ROOT_NODE_ID = 'root';
const DB_NAME = 'MindMapDB';
const STORE_NAME = 'mindmaps';

class MindMapDB {
    constructor() {
        this.db = null;
    }

    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onerror = () => reject("Error opening DB");
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('name', 'name', { unique: false });
                }
            };
        });
    }

    async getTransaction(mode) {
        if (!this.db) await this.open();
        return this.db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
    }

    async add(map) {
        const store = await this.getTransaction('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.add(map);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    
    async put(map) {
        const store = await this.getTransaction('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(map);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async get(id) {
        const store = await this.getTransaction('readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAll() {
        const store = await this.getTransaction('readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result.sort((a,b) => b.modifiedAt - a.modifiedAt));
            request.onerror = () => reject(request.error);
        });
    }

    async delete(id) {
        const store = await this.getTransaction('readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}


class MindMap {
    constructor(canvasId) {
        // DOM Elements
        this.canvas = document.getElementById(canvasId);
        this.svgLayer = document.getElementById('mindmap-svg-layer');
        this.nodesLayer = document.getElementById('mindmap-nodes-layer');
        this.addNodeBtn = document.getElementById('add-node-btn');
        this.deleteNodeBtn = document.getElementById('delete-node-btn');
        this.newMapBtn = document.getElementById('new-map-btn');
        this.saveMapBtn = document.getElementById('save-map-btn');
        this.undoBtn = document.getElementById('undo-btn');
        this.redoBtn = document.getElementById('redo-btn');
        this.sidePanel = document.getElementById('side-panel');
        this.panelToggleBtn = document.getElementById('panel-toggle-btn');
        this.savedMapsList = document.getElementById('saved-maps-list');
        
        // Style Buttons
        this.nodeStyleButtons = document.querySelectorAll('.node-style-btn');
        this.connectorStyleButtons = document.querySelectorAll('.connector-style-btn');

        // Instructions Panel
        this.instructionsPanel = document.getElementById('instructions');
        this.closeInstructionsBtn = document.getElementById('close-instructions-btn');
        this.showInstructionsBtn = document.getElementById('show-instructions-btn');
        
        // Panel Tabs
        this.filesTabBtn = document.getElementById('files-tab-btn');
        this.editorTabBtn = document.getElementById('editor-tab-btn');
        this.filesContent = document.getElementById('files-content');
        this.editorContent = document.getElementById('editor-content');
        this.markdownEditor = document.getElementById('markdown-editor');

        // Modal elements
        this.propertiesModalOverlay = document.getElementById('properties-modal-overlay');
        this.modalCloseBtn = document.getElementById('modal-close-btn');
        this.propMapName = document.getElementById('prop-map-name');
        this.propMapCreated = document.getElementById('prop-map-created');
        this.propMapModified = document.getElementById('prop-map-modified');

        // State Management
        this.nodes = {};
        this.selectedNodeId = null;
        this.scale = 1;
        this.pan = { x: 0, y: 0 };
        this.currentMapId = null;
        this.db = new MindMapDB();
        this.connectorStyle = 'straight';

        this.dragState = { isDraggingNode: false, nodeId: null, lastMousePos: { x: 0, y: 0 } };
        this.panState = { isPanning: false, lastMousePos: { x: 0, y: 0 } };
        
        // Auto-save & Editor state
        this.autoSaveTimer = null;
        this.isDirty = false;
        this.updateMapFromMarkdownDebounced = this.debounce(this.updateMapFromMarkdown, 750);

        // History Management (Undo/Redo)
        this.undoStack = [];
        this.redoStack = [];
        this.dragStartState = null;

        this.init();
    }

    async init() {
        await this.db.open();
        this.bindEventListeners();
        this.initInstructionsPanelState();
        await this.createNewMap();
        await this.renderSavedMapsList();
        this.updateTransform();
    }
    
    debounce(func, delay) {
        let timeout;
        return (...args) => {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), delay);
        };
    }

    // --- History (Undo/Redo) Management ---

    getSerializableState() {
        const serializableNodes = {};
        for (const id in this.nodes) {
            const node = this.nodes[id];
            serializableNodes[id] = {
                id: node.id,
                text: node.text,
                parentId: node.parentId,
                childrenIds: [...node.childrenIds],
                position: { ...node.position },
                isCollapsed: node.isCollapsed,
                style: node.style || 'rect',
            };
        }
        return { 
            nodes: serializableNodes, 
            selectedNodeId: this.selectedNodeId,
            connectorStyle: this.connectorStyle 
        };
    }
    
    pushHistoryState(stateBeforeAction) {
        this.undoStack.push(stateBeforeAction);
        this.redoStack = []; // A new action clears the redo stack
        this.updateUndoRedoButtons();
    }
    
    loadFromState(state) {
        if (!state) return;
        this.clearCanvas();
        
        const newNodes = {};
        for (const id in state.nodes) {
            newNodes[id] = { ...state.nodes[id], element: null };
        }
        this.nodes = newNodes;
        this.connectorStyle = state.connectorStyle || 'straight';

        for (const id in this.nodes) {
            const nodeData = this.nodes[id];
            const nodeEl = this.renderNodeDOM(nodeData.id, nodeData.text, nodeData.position, nodeData.style);
            nodeData.element = nodeEl;
        }

        this.updateUIVisibilityAndConnectors();
        if (state.selectedNodeId && this.nodes[state.selectedNodeId]) {
            this.selectNode(state.selectedNodeId);
        } else {
            this.selectNode(null);
        }
        this.updateMarkdownEditor();
        this.updateActiveConnectorStyleButton(this.connectorStyle);
    }

    undo() {
        if (this.undoStack.length === 0) return;
        
        const stateToRestore = this.undoStack.pop();
        const currentState = this.getSerializableState();
        this.redoStack.push(currentState);
        
        this.loadFromState(stateToRestore);
        this.updateUndoRedoButtons();
        this.triggerAutoSave();
    }

    redo() {
        if (this.redoStack.length === 0) return;
        
        const stateToRestore = this.redoStack.pop();
        const currentState = this.getSerializableState();
        this.undoStack.push(currentState);
        
        this.loadFromState(stateToRestore);
        this.updateUndoRedoButtons();
        this.triggerAutoSave();
    }

    // --- Core Node Management ---

    createNode(text, parentId, position, style = 'rect') {
        const id = parentId === null ? ROOT_NODE_ID : `node_${Date.now()}_${Math.random()}`;
        this.nodes[id] = { id, text, parentId, childrenIds: [], position, element: null, isCollapsed: false, style };
        const nodeEl = this.renderNodeDOM(id, text, position, style);
        this.nodes[id].element = nodeEl;
        if (parentId && this.nodes[parentId]) {
            this.nodes[parentId].childrenIds.push(id);
        }
        return id;
    }

    programmaticAddNode(parentId, text, style = 'rect') {
        if (!parentId || !this.nodes[parentId]) return null;
        const parentNode = this.nodes[parentId];
        
        const offsetX = 200;
        const baseOffsetY = 60;
        const siblingOffsetY = 100;
        let newPosition;
    
        const moveFirstChild = (firstChildId, newOffsetY) => {
            const firstChild = this.nodes[firstChildId];
            if (!firstChild) return;
            const delta = { dx: 0, dy: (parentNode.position.y + newOffsetY) - firstChild.position.y };
            this.moveNodeAndChildren(firstChildId, delta);
        };
    
        if (parentNode.id === ROOT_NODE_ID) {
            const childrenOnLeftIds = parentNode.childrenIds.filter(id => this.nodes[id].position.x < parentNode.position.x);
            const childrenOnRightIds = parentNode.childrenIds.filter(id => this.nodes[id].position.x > parentNode.position.x);
            
            const addOnLeft = childrenOnLeftIds.length <= childrenOnRightIds.length;
            const direction = addOnLeft ? -1 : 1;
            const childrenOnSide = addOnLeft ? childrenOnLeftIds : childrenOnRightIds;
            const countOnSide = childrenOnSide.length;
    
            let offsetY;
            if (countOnSide === 0) {
                offsetY = 0;
            } else if (countOnSide === 1) {
                moveFirstChild(childrenOnSide[0], -baseOffsetY);
                offsetY = baseOffsetY;
            } else {
                offsetY = (countOnSide % 2 === 0 ? 1 : -1) * (Math.floor(countOnSide / 2) * siblingOffsetY + baseOffsetY);
            }
            newPosition = { x: parentNode.position.x + (direction * offsetX), y: parentNode.position.y + offsetY };
    
        } else {
            const rootNode = this.nodes[ROOT_NODE_ID];
            const direction = (parentNode.position.x < rootNode.position.x) ? -1 : 1;
            const childCount = parentNode.childrenIds.length;
            
            let offsetY;
            if (childCount === 0) {
                offsetY = 0;
            } else if (childCount === 1) {
                moveFirstChild(parentNode.childrenIds[0], -baseOffsetY);
                offsetY = baseOffsetY;
            } else {
                offsetY = (childCount % 2 === 0 ? 1 : -1) * (Math.floor(childCount / 2) * siblingOffsetY + baseOffsetY);
            }
            newPosition = { x: parentNode.position.x + (direction * offsetX), y: parentNode.position.y + offsetY };
        }
        return this.createNode(text, parentId, newPosition, style);
    }
    
    addNodeForSelected() {
        if (!this.selectedNodeId) return;

        const stateBefore = this.getSerializableState();

        const newNodeId = this.programmaticAddNode(this.selectedNodeId, 'شاخه جدید');
        if(newNodeId) {
            this.selectNode(newNodeId);
            this.updateUIVisibilityAndConnectors();
            this.updateMarkdownEditor();
            this.makeNodeEditable(newNodeId);
            
            this.pushHistoryState(stateBefore);
            this.triggerAutoSave();
        }
    }

    deleteNode(nodeId) {
        if (!nodeId || nodeId === ROOT_NODE_ID) return;

        const stateBefore = this.getSerializableState();
        
        const allIdsToDelete = [nodeId, ...this.getAllDescendantIds(nodeId)];
        const nodeToDelete = this.nodes[nodeId];

        allIdsToDelete.forEach(id => {
            const node = this.nodes[id];
            if (node && node.element) node.element.remove();
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
        this.updateMarkdownEditor();
        
        this.pushHistoryState(stateBefore);
        this.triggerAutoSave();
        this.updateToolbarButtons();
    }
    
    // --- Map Data Management (DB, Markdown) ---
    
    triggerAutoSave() {
        clearTimeout(this.autoSaveTimer);
        this.isDirty = true;
        this.saveMapBtn.disabled = false;
        this.saveMapBtn.title = 'ذخیره نقشه فعلی';
        this.autoSaveTimer = setTimeout(async () => {
            await this.saveCurrentMap();
        }, 2500);
    }

    async saveCurrentMap() {
        clearTimeout(this.autoSaveTimer);
        if (!this.nodes[ROOT_NODE_ID] || !this.isDirty) return;

        this.saveMapBtn.title = 'در حال ذخیره...';
        this.saveMapBtn.disabled = true;

        const markdown = this.exportToMarkdown();
        const mapName = this.nodes[ROOT_NODE_ID].text;

        let mapData;
        if (this.currentMapId) {
            const existingMap = await this.db.get(this.currentMapId);
            mapData = {
                ...existingMap, // Preserve createdAt
                id: this.currentMapId,
                name: mapName,
                markdown,
                modifiedAt: new Date(),
                connectorStyle: this.connectorStyle
            };
            await this.db.put(mapData);
        } else {
            const id = Date.now();
            mapData = {
                id,
                name: mapName,
                markdown,
                createdAt: new Date(), // Set createdAt on creation
                modifiedAt: new Date(),
                connectorStyle: this.connectorStyle
            };
            const newId = await this.db.add(mapData);
            this.currentMapId = newId;
        }
        
        console.log(`Map '${mapName}' saved successfully.`);
        this.isDirty = false;
        
        this.saveMapBtn.title = 'ذخیره شد';
        
        await this.renderSavedMapsList();
    }

    async loadMap(mapId) {
        clearTimeout(this.autoSaveTimer);
        this.isDirty = false;
        const map = await this.db.get(mapId);
        if (!map) return;
        this.clearCanvas();
        this.importFromMarkdown(map.markdown);
        this.currentMapId = map.id;
        this.connectorStyle = map.connectorStyle || 'straight';
        this.updateActiveConnectorStyleButton(this.connectorStyle);
        this.updateUIVisibilityAndConnectors();
        this.updateMarkdownEditor();
        this.selectNode(ROOT_NODE_ID);

        this.undoStack = [];
        this.redoStack = [];
        this.updateUndoRedoButtons();
        
        await this.renderSavedMapsList();
        if(this.sidePanel.classList.contains('open')) {
            this.panelToggleBtn.click();
        }
        this.saveMapBtn.title = 'ذخیره نقشه فعلی';
        this.saveMapBtn.disabled = true;
    }
    
    async deleteMap(mapId) {
        const map = await this.db.get(mapId);
        if(!map) return;
        if (!confirm(`آیا از حذف نقشه "${map.name}" مطمئن هستید؟`)) return;

        await this.db.delete(mapId);
        if (this.currentMapId === mapId) {
            await this.createNewMap();
        }
        await this.renderSavedMapsList();
    }
    
    async renameMap(mapId) {
        const map = await this.db.get(mapId);
        if(!map) return;
        const newName = prompt("نام جدید نقشه را وارد کنید:", map.name);
        if (newName && newName.trim() !== '') {
            if(map.id === this.currentMapId) {
                const stateBefore = this.getSerializableState();
                this._updateNodeTextAndSave(ROOT_NODE_ID, newName, stateBefore);
            } else {
                map.name = newName.trim();
                map.modifiedAt = new Date();
                map.markdown = this.exportToMarkdownFromData(map.markdown, newName);
                await this.db.put(map);
            }
            await this.renderSavedMapsList();
        }
    }
    
    async downloadMap(mapId) {
        const map = await this.db.get(mapId);
        if (!map) return;
        const blob = new Blob([map.markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${map.name.replace(/ /g, '_')}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    exportToMarkdown() {
        const buildMarkdownRecursive = (nodeId, depth) => {
            const node = this.nodes[nodeId];
            if (!node) return '';
            const indent = '  '.repeat(depth);
            let textPart = `- ${node.text}`;
            if (node.style && node.style !== 'rect') {
                textPart += ` {style:${node.style}}`;
            }
            let result = `${indent}${textPart}\n`;
            if (!node.isCollapsed) {
                node.childrenIds.forEach(childId => {
                    result += buildMarkdownRecursive(childId, depth + 1);
                });
            }
            return result;
        };
        return buildMarkdownRecursive(ROOT_NODE_ID, 0);
    }
    
    exportToMarkdownFromData(markdown, newRootText) {
        const lines = markdown.split('\n');
        const firstLine = lines[0];
        const styleMatch = firstLine.match(/ {style:(\w+)}$/);
        let newFirstLine = `- ${newRootText}`;
        if(styleMatch){
            newFirstLine += ` ${styleMatch[0]}`;
        }
        lines[0] = newFirstLine;
        return lines.join('\n');
    }

    importFromMarkdown(markdown) {
        const lines = markdown.split('\n').filter(line => line.trim() !== '');
        if (lines.length === 0) {
            this.createRootNode('موضوع اصلی');
            return;
        }

        const parentStack = [];
        const levelStack = [];

        lines.forEach((line) => {
            const indent = line.match(/^\s*/)[0];
            const level = indent.length / 2;
            
            const lineContent = line.trim().substring(2);
            const styleMatch = lineContent.match(/ {style:(\w+)}$/);
            let text = lineContent;
            let style = 'rect';
            if (styleMatch) {
                text = lineContent.substring(0, styleMatch.index).trim();
                style = styleMatch[1];
            }

            if (level === 0) {
                const rootId = this.createRootNode(text);
                this.nodes[rootId].style = style;
                parentStack.push(rootId);
                levelStack.push(level);
            } else {
                while (level <= levelStack[levelStack.length - 1] && levelStack.length > 0) {
                    parentStack.pop();
                    levelStack.pop();
                }
                const parentId = parentStack[parentStack.length - 1];
                const newNodeId = this.programmaticAddNode(parentId, text, style);
                if(newNodeId) {
                    parentStack.push(newNodeId);
                    levelStack.push(level);
                }
            }
        });
    }

    async createNewMap() {
        clearTimeout(this.autoSaveTimer);
        this.isDirty = false;
        this.clearCanvas();
        this.currentMapId = null;
        this.connectorStyle = 'straight';
        this.updateActiveConnectorStyleButton(this.connectorStyle);
        this.createRootNode('موضوع اصلی');
        this.updateUIVisibilityAndConnectors();
        this.updateMarkdownEditor();
        this.selectNode(ROOT_NODE_ID);
        
        this.undoStack = [];
        this.redoStack = [];
        this.updateUndoRedoButtons();
        
        this.updateToolbarButtons();
        this.saveMapBtn.title = 'ذخیره نقشه فعلی';
        this.saveMapBtn.disabled = true;
        await this.renderSavedMapsList();
    }
    
    createRootNode(text) {
        this.clearCanvas();
        const rootNodeId = this.createNode(text, null, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
        this.selectNode(rootNodeId);
        return rootNodeId;
    }
    
    clearCanvas() {
        this.nodes = {};
        this.nodesLayer.innerHTML = '';
        this.svgLayer.innerHTML = '';
        this.selectedNodeId = null;
    }

    // --- UI and Rendering ---

    async renderSavedMapsList() {
        const maps = await this.db.getAll();
        this.savedMapsList.innerHTML = '';
        if (maps.length === 0) {
            this.savedMapsList.innerHTML = `<li class="no-maps" style="padding: 1rem;">هیچ نقشه‌ای ذخیره نشده است.</li>`;
            return;
        }
        maps.forEach(map => {
            const li = document.createElement('li');
            li.dataset.mapId = map.id;
            if (map.id === this.currentMapId) {
                li.classList.add('active');
            }
            
            li.innerHTML = `
                <div class="map-info">
                    <span class="map-name">${map.name}</span>
                </div>
                <div class="map-menu-container">
                    <button class="menu-toggle-btn" aria-label="منوی گزینه‌ها">⋮</button>
                    <div class="map-item-menu">
                        <button class="rename-btn">تغییر نام</button>
                        <button class="download-btn">دانلود</button>
                        <button class="properties-btn">ویژگی‌ها</button>
                        <button class="delete-btn">حذف</button>
                    </div>
                </div>
            `;
            
            li.querySelector('.map-info').addEventListener('click', () => this.loadMap(map.id));
            
            const menuToggle = li.querySelector('.menu-toggle-btn');
            const menu = li.querySelector('.map-item-menu');
            
            menuToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.map-item-menu.open').forEach(openMenu => {
                    if (openMenu !== menu) openMenu.classList.remove('open');
                });
                menu.classList.toggle('open');
            });
            
            menu.querySelector('.properties-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); this.showMapProperties(map.id); });
            menu.querySelector('.rename-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); this.renameMap(map.id); });
            menu.querySelector('.download-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); this.downloadMap(map.id); });
            menu.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); this.deleteMap(map.id); });
            
            this.savedMapsList.appendChild(li);
        });
    }

    async showMapProperties(mapId) {
        const map = await this.db.get(mapId);
        if (!map) return;

        this.propMapName.textContent = map.name;
        this.propMapCreated.textContent = new Date(map.createdAt || map.modifiedAt).toLocaleString('fa-IR');
        this.propMapModified.textContent = new Date(map.modifiedAt).toLocaleString('fa-IR');

        this.propertiesModalOverlay.style.display = 'flex';
    }

    hideMapProperties() {
        this.propertiesModalOverlay.style.display = 'none';
    }

    updateMarkdownEditor() {
        if (!this.nodes[ROOT_NODE_ID]) return;
        const markdown = this.exportToMarkdown();
        if (this.markdownEditor.value !== markdown) {
            this.markdownEditor.value = markdown;
        }
    }
    
    updateMapFromMarkdown() {
        const newMarkdown = this.markdownEditor.value;
        const currentMarkdown = this.exportToMarkdown();
        if (newMarkdown === currentMarkdown) {
            return;
        }

        const stateBefore = this.getSerializableState();

        const preservedState = {
            id: this.currentMapId,
            scale: this.scale,
            pan: this.pan,
            connectorStyle: this.connectorStyle
        };

        this.clearCanvas();
        this.currentMapId = preservedState.id;
        this.connectorStyle = preservedState.connectorStyle;

        this.importFromMarkdown(newMarkdown);
        
        this.scale = preservedState.scale;
        this.pan = preservedState.pan;
        this.updateTransform();

        this.updateUIVisibilityAndConnectors();
        this.selectNode(ROOT_NODE_ID);

        this.pushHistoryState(stateBefore);
        this.triggerAutoSave();
    }

    renderNodeDOM(nodeId, text, position, style = 'rect') {
        const nodeEl = document.createElement('div');
        nodeEl.id = `node-${nodeId}`;
        nodeEl.className = 'mindmap-node';
        nodeEl.classList.add(`node-style-${style}`);
        nodeEl.style.left = `${position.x}px`;
        nodeEl.style.top = `${position.y}px`;

        const textSpan = document.createElement('span');
        textSpan.className = 'node-text';
        textSpan.textContent = text;
        nodeEl.appendChild(textSpan);

        nodeEl.addEventListener('mousedown', (e) => { e.stopPropagation(); this.handleDragStart(e, nodeId); });
        nodeEl.addEventListener('dblclick', (e) => { e.stopPropagation(); this.makeNodeEditable(nodeId); });
        nodeEl.addEventListener('click', (e) => { e.stopPropagation(); this.selectNode(nodeId); });

        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'collapse-btn';
        collapseBtn.setAttribute('aria-label', 'جمع/باز کردن گره');
        collapseBtn.style.display = 'none'; // Initially hidden
        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleCollapse(nodeId);
        });
        nodeEl.appendChild(collapseBtn);

        this.nodesLayer.appendChild(nodeEl);
        return nodeEl;
    }
    
    _updateNodeText(nodeId, newText) {
        const nodeData = this.nodes[nodeId];
        if (nodeData) {
            const trimmedText = newText.trim();
            if (trimmedText) {
                nodeData.text = trimmedText;
                if (nodeData.element) {
                    const textSpan = nodeData.element.querySelector('.node-text');
                    if (textSpan) {
                        textSpan.textContent = trimmedText;
                    }
                }
            }
        }
    }
    
    _updateNodeTextAndSave(nodeId, newText, stateBefore) {
        this._updateNodeText(nodeId, newText);
        this.pushHistoryState(stateBefore);
        this.updateMarkdownEditor();
        if (nodeId === ROOT_NODE_ID) {
           this.renderSavedMapsList();
        }
        this.triggerAutoSave();
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
            const oldText = nodeData.text;
            const newText = input.value.trim() || oldText;
            
            if (nodeEl.contains(input)) {
                nodeEl.replaceChild(textSpan, input);
            }
            
            if (newText !== oldText) {
                const stateBefore = this.getSerializableState();
                this._updateNodeTextAndSave(nodeId, newText, stateBefore);
            }
        };
        
        input.addEventListener('blur', saveChanges);
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                e.preventDefault(); input.blur();
            } else if (e.key === 'Escape') {
                input.value = nodeData.text; input.blur();
            }
        });
        
        nodeEl.replaceChild(input, textSpan);
        input.focus();
        input.select();
    }
    
    // --- Event Listeners and Handlers ---

    bindEventListeners() {
        this.canvas.addEventListener('mousedown', this.handlePanStart.bind(this));
        document.addEventListener('mousemove', this.handleMouseMove.bind(this));
        document.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));
        document.addEventListener('keydown', this.handleKeyDown.bind(this));

        // Toolbar buttons
        this.addNodeBtn.addEventListener('click', () => this.addNodeForSelected());
        this.deleteNodeBtn.addEventListener('click', () => {
            if (this.selectedNodeId) {
                this.deleteNode(this.selectedNodeId);
            }
        });
        this.newMapBtn.addEventListener('click', () => this.createNewMap());
        this.saveMapBtn.addEventListener('click', () => this.saveCurrentMap());
        this.undoBtn.addEventListener('click', () => this.undo());
        this.redoBtn.addEventListener('click', () => this.redo());

        // Style buttons
        this.nodeStyleButtons.forEach(btn => btn.addEventListener('click', () => this.setNodeStyle(btn.dataset.style)));
        this.connectorStyleButtons.forEach(btn => btn.addEventListener('click', () => this.setConnectorStyle(btn.dataset.style)));


        // Instructions Panel
        this.closeInstructionsBtn.addEventListener('click', () => this.setInstructionsVisibility(false));
        this.showInstructionsBtn.addEventListener('click', () => this.setInstructionsVisibility(true));
        
        // Side panel
        this.panelToggleBtn.addEventListener('click', () => {
            this.sidePanel.classList.toggle('open');
        });
        this.filesTabBtn.addEventListener('click', () => this.switchTab('files'));
        this.editorTabBtn.addEventListener('click', () => this.switchTab('editor'));
        this.markdownEditor.addEventListener('input', () => this.updateMapFromMarkdownDebounced());
        
        // Modal
        this.modalCloseBtn.addEventListener('click', () => this.hideMapProperties());
        this.propertiesModalOverlay.addEventListener('click', (e) => {
            if (e.target === this.propertiesModalOverlay) {
                this.hideMapProperties();
            }
        });
        
        // Close open menus when clicking elsewhere
        document.addEventListener('click', (e) => {
            const openMenu = document.querySelector('.map-item-menu.open');
            if (openMenu && !openMenu.parentElement.contains(e.target)) {
                 openMenu.classList.remove('open');
            }
        });
    }

    initInstructionsPanelState() {
        const isVisible = localStorage.getItem('instructionsVisible') !== 'false';
        if (!isVisible) {
            this.instructionsPanel.classList.add('closed');
            this.showInstructionsBtn.classList.add('visible');
        }
    }
    
    setInstructionsVisibility(visible) {
        if (visible) {
            this.instructionsPanel.classList.remove('closed');
            this.showInstructionsBtn.classList.remove('visible');
            localStorage.setItem('instructionsVisible', 'true');
        } else {
            this.instructionsPanel.classList.add('closed');
            this.showInstructionsBtn.classList.add('visible');
            localStorage.setItem('instructionsVisible', 'false');
        }
    }

    switchTab(tabName) {
        const isFiles = tabName === 'files';
        this.filesTabBtn.classList.toggle('active', isFiles);
        this.editorTabBtn.classList.toggle('active', !isFiles);
        this.filesContent.classList.toggle('active', isFiles);
        this.editorContent.classList.toggle('active', !isFiles);
        
        if (!isFiles) {
            this.updateMarkdownEditor();
        }
    }

    handleKeyDown(e) {
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.querySelector('#properties-modal-overlay[style*="display: flex"]')) {
            if (e.key === 'Escape') this.hideMapProperties();
            return;
        }
        
        if (e.ctrlKey) {
            if (e.key === 's') {
                e.preventDefault();
                this.saveCurrentMap();
                return;
            }
            if (e.key === 'z') {
                e.preventDefault();
                this.undo();
                return;
            }
            if (e.key === 'y') {
                e.preventDefault();
                this.redo();
                return;
            }
        }

        if (!this.selectedNodeId) return;

        switch (e.key) {
            case 'Tab':
                e.preventDefault(); this.addNodeForSelected(); break;
            case 'F2':
                e.preventDefault(); this.makeNodeEditable(this.selectedNodeId); break;
            case 'Delete':
                e.preventDefault(); this.deleteNode(this.selectedNodeId); break;
        }
    }
    
    selectNode(nodeId) {
        if(nodeId && this.isAnyAncestorCollapsed(nodeId)) return;
        if (this.selectedNodeId && this.nodes[this.selectedNodeId]) {
            this.nodes[this.selectedNodeId].element.classList.remove('selected');
        }
        this.selectedNodeId = nodeId;
        if (this.selectedNodeId && this.nodes[this.selectedNodeId]) {
            this.nodes[this.selectedNodeId].element.classList.add('selected');
        }
        this.updateToolbarButtons();
    }

    updateToolbarButtons() {
        const nothingSelected = !this.selectedNodeId;
        const rootSelected = this.selectedNodeId === ROOT_NODE_ID;
    
        this.addNodeBtn.disabled = nothingSelected;
        this.deleteNodeBtn.disabled = nothingSelected || rootSelected;
        this.nodeStyleButtons.forEach(btn => btn.disabled = nothingSelected);
    
        if (nothingSelected) {
            this.addNodeBtn.title = 'برای افزودن شاخه، یک گره را انتخاب کنید';
            this.deleteNodeBtn.title = 'برای حذف، یک گره را انتخاب کنید';
            this.updateActiveNodeStyleButton(null);
        } else {
            this.addNodeBtn.title = 'افزودن شاخه به گره انتخاب‌شده';
            if (rootSelected) {
                this.deleteNodeBtn.title = 'گره اصلی را نمی‌توان حذف کرد';
            } else {
                this.deleteNodeBtn.title = 'حذف گره انتخاب‌شده';
            }
            const style = this.nodes[this.selectedNodeId]?.style || 'rect';
            this.updateActiveNodeStyleButton(style);
        }
    }

    updateUndoRedoButtons() {
        this.undoBtn.disabled = this.undoStack.length === 0;
        this.redoBtn.disabled = this.redoStack.length === 0;
    
        this.undoBtn.title = this.undoBtn.disabled ? 'واگرد' : 'واگرد (Ctrl+Z)';
        this.redoBtn.title = this.redoBtn.disabled ? 'ازنو' : 'ازنو (Ctrl+Y)';
    }

    updateActiveNodeStyleButton(style) {
        this.nodeStyleButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.style === style);
        });
    }

    updateActiveConnectorStyleButton(style) {
        this.connectorStyleButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.style === style);
        });
    }

    setNodeStyle(style) {
        if (!this.selectedNodeId) return;
        const stateBefore = this.getSerializableState();

        const node = this.nodes[this.selectedNodeId];
        const oldStyle = node.style || 'rect';
        node.style = style;
        node.element.classList.remove(`node-style-${oldStyle}`);
        node.element.classList.add(`node-style-${style}`);

        this.updateActiveNodeStyleButton(style);
        this.pushHistoryState(stateBefore);
        this.triggerAutoSave();
        this.updateMarkdownEditor();
    }

    setConnectorStyle(style) {
        if (this.connectorStyle === style) return;
        const stateBefore = this.getSerializableState();

        this.connectorStyle = style;
        this.updateActiveConnectorStyleButton(style);
        this.updateUIVisibilityAndConnectors();
        
        this.pushHistoryState(stateBefore);
        this.triggerAutoSave();
    }
    
    updateTransform() {
        const transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.scale})`;
        this.nodesLayer.style.transform = transform;
        this.svgLayer.style.transform = transform;
    }
    
    toggleCollapse(nodeId) {
        const node = this.nodes[nodeId];
        if (!node || node.childrenIds.length === 0) return;

        const stateBefore = this.getSerializableState();

        node.isCollapsed = !node.isCollapsed;
        if (node.isCollapsed) {
            const descendantIds = this.getAllDescendantIds(nodeId);
            if (descendantIds.includes(this.selectedNodeId)) {
                this.selectNode(nodeId);
            }
        }
        this.updateUIVisibilityAndConnectors();
        this.updateMarkdownEditor();
        
        this.pushHistoryState(stateBefore);
        this.triggerAutoSave();
    }
    
    updateUIVisibilityAndConnectors() {
        this.svgLayer.innerHTML = '';
        Object.values(this.nodes).forEach(node => {
            if(!node.element) return;
            const collapseBtn = node.element.querySelector('.collapse-btn');
            if (collapseBtn) {
                const hasVisibleChildren = node.childrenIds.some(id => this.nodes[id]);
                if (hasVisibleChildren) {
                    collapseBtn.style.display = 'flex';
                    collapseBtn.textContent = node.isCollapsed ? '+' : '−';
                    const childPositionsX = node.childrenIds.map(id => this.nodes[id].position.x);
                    const allToTheRight = childPositionsX.every(x => x > node.position.x);
                    const allToTheLeft = childPositionsX.every(x => x < node.position.x);
                    Object.assign(collapseBtn.style, { left: '', right: '', top: '', bottom: '', transform: '' });
                    if (allToTheRight) {
                        collapseBtn.style.right = '-0.75rem'; collapseBtn.style.top = '50%'; collapseBtn.style.transform = 'translateY(-50%)';
                    } else if (allToTheLeft) {
                        collapseBtn.style.left = '-0.75rem'; collapseBtn.style.top = '50%'; collapseBtn.style.transform = 'translateY(-50%)';
                    } else {
                        collapseBtn.style.left = '50%'; collapseBtn.style.bottom = '-0.75rem'; collapseBtn.style.transform = 'translateX(-50%)';
                    }
                } else {
                    collapseBtn.style.display = 'none';
                }
            }
            const isVisible = !this.isAnyAncestorCollapsed(node.id);
            node.element.style.display = isVisible ? 'flex' : 'none';
            if (isVisible && node.parentId && this.nodes[node.parentId]) {
                this.drawConnector(this.nodes[node.parentId].position, node.position);
            }
        });
    }

    getCurvedPathData(from, to) {
        const dx = to.x - from.x;
        const c1x = from.x + dx * 0.5;
        const c1y = from.y;
        const c2x = to.x - dx * 0.5;
        const c2y = to.y;
        return `M ${from.x},${from.y} C ${c1x},${c1y} ${c2x},${c2y} ${to.x},${to.y}`;
    }

    getSteppedPathData(from, to) {
        const midX = from.x + (to.x - from.x) / 2;
        return `M ${from.x},${from.y} L ${midX},${from.y} L ${midX},${to.y} L ${to.x},${to.y}`;
    }

    drawConnector(fromPos, toPos) {
        let connectorEl;
        switch (this.connectorStyle) {
            case 'curved':
                connectorEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                connectorEl.setAttribute('d', this.getCurvedPathData(fromPos, toPos));
                break;
            case 'stepped':
                connectorEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                connectorEl.setAttribute('d', this.getSteppedPathData(fromPos, toPos));
                break;
            case 'straight':
            default:
                connectorEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                connectorEl.setAttribute('x1', fromPos.x); connectorEl.setAttribute('y1', fromPos.y);
                connectorEl.setAttribute('x2', toPos.x); connectorEl.setAttribute('y2', toPos.y);
                break;
        }
        connectorEl.setAttribute('class', 'connector-line');
        this.svgLayer.appendChild(connectorEl);
    }
    
    handleDragStart(e, nodeId) {
        if (e.button !== 0) return;
        this.dragStartState = this.getSerializableState();
        this.dragState = { isDraggingNode: true, nodeId: nodeId, lastMousePos: { x: e.clientX, y: e.clientY } };
    }

    handlePanStart(e) {
        if (e.target.closest('.mindmap-node') || e.target.closest('#markdown-editor') || e.button !== 0) return;
        e.preventDefault();
        this.panState = { isPanning: true, lastMousePos: { x: e.clientX, y: e.clientY } };
        this.canvas.classList.add('panning');
    }
    
    handleMouseMove(e) {
        if (this.panState.isPanning) {
            const dx = e.clientX - this.panState.lastMousePos.x;
            const dy = e.clientY - this.panState.lastMousePos.y;
            this.pan.x += dx; this.pan.y += dy;
            this.updateTransform();
            this.panState.lastMousePos = { x: e.clientX, y: e.clientY };
        } else if (this.dragState.isDraggingNode) {
            const dx = (e.clientX - this.dragState.lastMousePos.x) / this.scale;
            const dy = (e.clientY - this.dragState.lastMousePos.y) / this.scale;
            this.moveNodeAndChildren(this.dragState.nodeId, { dx, dy });
            this.dragState.lastMousePos = { x: e.clientX, y: e.clientY };
        }
    }
    
    handleMouseUp() {
        if (this.panState.isPanning) {
            this.panState.isPanning = false; this.canvas.classList.remove('panning');
        }
        if (this.dragState.isDraggingNode) {
            if(this.dragStartState) {
                this.pushHistoryState(this.dragStartState);
                this.dragStartState = null;
            }
            this.dragState.isDraggingNode = false; 
            this.dragState.nodeId = null;
            this.triggerAutoSave();
        }
    }

    handleWheel(e) {
        if (e.target.closest('#side-panel')) return;
        e.preventDefault();
        const zoomFactor = 1.1;
        const oldScale = this.scale;
        this.scale *= (e.deltaY < 0) ? zoomFactor : 1 / zoomFactor;
        this.scale = Math.max(0.2, Math.min(this.scale, 4));
        const mousePoint = { x: e.clientX, y: e.clientY };
        const worldX = (mousePoint.x - this.pan.x) / oldScale;
        const worldY = (mousePoint.y - this.pan.y) / oldScale;
        this.pan.x = mousePoint.x - worldX * this.scale;
        this.pan.y = mousePoint.y - worldY * this.scale;
        this.updateTransform();
    }
    
    updateNodePosition(nodeId, position) {
        const node = this.nodes[nodeId];
        if (node) {
            node.position = position;
            node.element.style.left = `${position.x}px`;
            node.element.style.top = `${position.y}px`;
        }
    }

    moveNodeAndChildren(rootNodeId, delta) {
        const idsToMove = [rootNodeId, ...this.getAllDescendantIds(rootNodeId)];
        idsToMove.forEach(id => {
            const node = this.nodes[id];
            if (node) {
                const newPosition = { x: node.position.x + delta.dx, y: node.position.y + delta.dy };
                this.updateNodePosition(id, newPosition);
            }
        });
        this.updateUIVisibilityAndConnectors();
    }
    
    getAllDescendantIds(nodeId) {
        const node = this.nodes[nodeId];
        if (!node || !node.childrenIds || node.childrenIds.length === 0 || node.isCollapsed) return [];
        return node.childrenIds.flatMap(childId => [childId, ...this.getAllDescendantIds(childId)]);
    }

    isAnyAncestorCollapsed(nodeId) {
        let currentId = this.nodes[nodeId]?.parentId;
        while (currentId) {
            const currentNode = this.nodes[currentId];
            if (currentNode.isCollapsed) return true;
            currentId = currentNode.parentId;
        }
        return false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new MindMap('mindmap-canvas');
});