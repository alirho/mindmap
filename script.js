

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
        this.uploadMapBtn = document.getElementById('upload-map-btn');
        this.uploadInput = document.getElementById('upload-input');
        this.undoBtn = document.getElementById('undo-btn');
        this.redoBtn = document.getElementById('redo-btn');
        this.sidePanel = document.getElementById('side-panel');
        this.panelToggleBtn = document.getElementById('panel-toggle-btn');
        this.savedMapsList = document.getElementById('saved-maps-list');
        
        // Style Buttons
        this.nodeStyleButtons = document.querySelectorAll('.node-style-btn');
        this.connectorStyleButtons = document.querySelectorAll('.connector-style-btn');
        this.layoutButtons = document.querySelectorAll('.layout-btn');

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
        this.modalOverlay = document.getElementById('modal-overlay');
        this.modalTitle = document.getElementById('modal-title');
        this.modalBody = document.getElementById('modal-body');
        this.modalFooter = document.getElementById('modal-footer');
        this.modalCloseBtn = document.getElementById('modal-close-btn');

        // State Management
        this.nodes = {};
        this.selectedNodeIds = [];
        this.scale = 1;
        this.pan = { x: 0, y: 0 };
        this.currentMapId = null;
        this.db = new MindMapDB();
        this.connectorStyle = 'straight';
        this.layoutMode = 'bidirectional';

        this.dragState = { isDraggingNode: false, hasDragged: false, nodeId: null, lastMousePos: { x: 0, y: 0 } };
        this.panState = { isPanning: false, hasPanned: false, lastMousePos: { x: 0, y: 0 } };
        
        // Auto-save & Editor state
        this.autoSaveTimer = null;
        this.isDirty = false;
        this.updateMapFromMarkdownDebounced = this.debounce(this.updateMapFromMarkdown, 750);

        // History Management (Undo/Redo)
        this.undoStack = [];
        this.redoStack = [];
        this.dragStartState = null;
        
        // Navigation state for keyboard
        this.navigationState = null;

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
            selectedNodeIds: [...this.selectedNodeIds],
            connectorStyle: this.connectorStyle,
            layoutMode: this.layoutMode
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
        this.layoutMode = state.layoutMode || 'bidirectional';

        for (const id in this.nodes) {
            const nodeData = this.nodes[id];
            const nodeEl = this.renderNodeDOM(nodeData.id, nodeData.text, nodeData.position, nodeData.style);
            nodeData.element = nodeEl;
        }

        this.updateUIVisibilityAndConnectors();
        
        this.clearSelection();
        if (state.selectedNodeIds) {
            state.selectedNodeIds.forEach(id => {
                if (this.nodes[id]) {
                    this.selectedNodeIds.push(id);
                    this.nodes[id].element.classList.add('selected');
                }
            });
        }
        this.updateToolbarButtons();

        this.updateMarkdownEditor();
        this.updateActiveConnectorStyleButton(this.connectorStyle);
        this.updateActiveLayoutButton(this.layoutMode);
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
        
        const offsetX = 160;
        const baseOffsetY = 40;
        const siblingOffsetY = 80;
        let newPosition;
    
        const moveFirstChild = (firstChildId, newOffsetY) => {
            const firstChild = this.nodes[firstChildId];
            if (!firstChild) return;
            const delta = { dx: 0, dy: (parentNode.position.y + newOffsetY) - firstChild.position.y };
            this.moveNodeAndChildren(firstChildId, delta);
        };
    
        if (parentNode.id === ROOT_NODE_ID && this.layoutMode === 'bidirectional') {
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
            let direction = -1; // Default to left for RTL layout
            if (this.layoutMode === 'bidirectional') {
                direction = (parentNode.position.x < rootNode.position.x) ? -1 : 1;
            }
            
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
        const parentId = this.getActiveNodeId();
        if (!parentId) return;

        const stateBefore = this.getSerializableState();

        const newNodeId = this.programmaticAddNode(parentId, 'شاخه جدید');
        if(newNodeId) {
            this.selectNode(newNodeId);
            this.updateUIVisibilityAndConnectors();
            this.updateMarkdownEditor();
            this.makeNodeEditable(newNodeId);
            
            this.pushHistoryState(stateBefore);
            this.triggerAutoSave();
        }
    }

    deleteSelectedNodes() {
        const idsToDelete = this.selectedNodeIds.filter(id => id !== ROOT_NODE_ID);
        if (idsToDelete.length === 0) return;

        const stateBefore = this.getSerializableState();
        
        const allIdsToDelete = new Set(idsToDelete);
        idsToDelete.forEach(id => {
            this.getAllDescendantIds(id).forEach(descId => allIdsToDelete.add(descId));
        });
        
        let nextNodeToSelect = null;
        const firstNodeData = this.nodes[idsToDelete[0]];
        if (firstNodeData && firstNodeData.parentId && this.nodes[firstNodeData.parentId]) {
            nextNodeToSelect = firstNodeData.parentId;
        }
        
        allIdsToDelete.forEach(id => {
            const node = this.nodes[id];
            if (node && node.element) node.element.remove();
            delete this.nodes[id];
        });

        Object.values(this.nodes).forEach(node => {
            node.childrenIds = node.childrenIds.filter(childId => !allIdsToDelete.has(childId));
        });

        this.selectNode(nextNodeToSelect);
        
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
                connectorStyle: this.connectorStyle,
                layoutMode: this.layoutMode
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
                connectorStyle: this.connectorStyle,
                layoutMode: this.layoutMode
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
        this.layoutMode = map.layoutMode || 'bidirectional';
        this.updateActiveConnectorStyleButton(this.connectorStyle);
        this.updateActiveLayoutButton(this.layoutMode);
        this.updateUIVisibilityAndConnectors();
        this.updateMarkdownEditor();
        this.selectNode(ROOT_NODE_ID);

        this.undoStack = [];
        this.redoStack = [];
        this.updateUndoRedoButtons();
        
        await this.renderSavedMapsList();

        this.saveMapBtn.title = 'ذخیره نقشه فعلی';
        this.saveMapBtn.disabled = true;
    }
    
    async deleteMap(mapId) {
        const map = await this.db.get(mapId);
        if(!map) return;
        
        const confirmed = await this._showModal({
            title: 'حذف نقشه',
            body: `<p>آیا از حذف نقشه <strong>"${map.name}"</strong> مطمئن هستید؟ این عمل قابل بازگشت نیست.</p>`,
            buttons: [
                { text: 'حذف', class: 'danger', value: true },
                { text: 'انصراف', class: 'default', value: false }
            ]
        });

        if (!confirmed) return;

        await this.db.delete(mapId);
        if (this.currentMapId === mapId) {
            await this.createNewMap();
        }
        await this.renderSavedMapsList();
    }
    
    async renameMap(mapId) {
        const map = await this.db.get(mapId);
        if(!map) return;

        const newName = await this._showModal({
            title: 'تغییر نام نقشه',
            body: `<input type="text" id="modal-input" class="modal-input" value="${map.name}" placeholder="نام جدید نقشه را وارد کنید" required>`,
            buttons: [
                { text: 'ذخیره', class: 'primary', value: 'resolve' },
                { text: 'انصراف', class: 'default', value: false }
            ]
        });

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
    
    async handleFileUpload(event) {
        const file = event.target.files[0];
        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
            const content = e.target.result;

            const lines = content.split('\n').filter(line => line.trim() !== '');
            if (lines.length === 0 || !lines[0].trim().startsWith('- ')) {
                await this._showModal({
                    title: 'قالب نامعتبر',
                    body: '<p>قالب فایل مارک‌داون نامعتبر است یا فایل خالی می‌باشد.</p>',
                    buttons: [{ text: 'متوجه شدم', class: 'primary', value: true }]
                });
                this.uploadInput.value = ''; // Reset for re-upload
                return;
            }

            clearTimeout(this.autoSaveTimer);
            this.isDirty = false;
            this.clearCanvas();
            this.currentMapId = null;
            this.connectorStyle = 'straight';
            this.layoutMode = 'bidirectional';
            this.updateActiveConnectorStyleButton(this.connectorStyle);
            this.updateActiveLayoutButton(this.layoutMode);

            this.importFromMarkdown(content);

            this.updateUIVisibilityAndConnectors();
            this.updateMarkdownEditor();
            this.selectNode(ROOT_NODE_ID);
            
            this.undoStack = [];
            this.redoStack = [];
            this.updateUndoRedoButtons();
            
            this.updateToolbarButtons();
            this.saveMapBtn.title = 'ذخیره نقشه فعلی';
            this.saveMapBtn.disabled = false;
            this.isDirty = true;
            await this.renderSavedMapsList();
            
            this.uploadInput.value = '';
        };

        reader.onerror = async () => {
             await this._showModal({
                title: 'خطا',
                body: '<p>خطا در خواندن فایل.</p>',
                buttons: [{ text: 'متوجه شدم', class: 'primary', value: true }]
            });
            this.uploadInput.value = '';
        };
        
        reader.readAsText(file);
    }

    exportToMarkdown(excludeStyles = false) {
        const buildMarkdownRecursive = (nodeId, depth, exclude) => {
            const node = this.nodes[nodeId];
            if (!node) return '';
            const indent = '  '.repeat(depth);
            let textPart = `- ${node.text}`;
            if (!exclude && node.style && node.style !== 'rect') {
                textPart += ` {style:${node.style}}`;
            }
            let result = `${indent}${textPart}\n`;
            if (!node.isCollapsed) {
                node.childrenIds.forEach(childId => {
                    result += buildMarkdownRecursive(childId, depth + 1, exclude);
                });
            }
            return result;
        };
        return buildMarkdownRecursive(ROOT_NODE_ID, 0, excludeStyles);
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
        this.layoutMode = 'bidirectional';
        this.updateActiveConnectorStyleButton(this.connectorStyle);
        this.updateActiveLayoutButton(this.layoutMode);
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
        this.selectedNodeIds = [];
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
            
            li.querySelector('.map-info').addEventListener('click', () => {
                this.loadMap(map.id);
            });
            
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

        const body = `
            <p><strong>نام:</strong> <span>${map.name}</span></p>
            <p><strong>تاریخ ایجاد:</strong> <span>${new Date(map.createdAt || map.modifiedAt).toLocaleString('fa-IR')}</span></p>
            <p><strong>آخرین ویرایش:</strong> <span>${new Date(map.modifiedAt).toLocaleString('fa-IR')}</span></p>
        `;

        await this._showModal({
            title: 'ویژگی‌های نقشه',
            body: body,
            buttons: [{ text: 'بستن', class: 'primary', value: true }]
        });
    }

    renderMarkdown(text) {
        if (!text) return '';

        let html = text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

        // Links [text](url)
        html = html.replace(/\[(.*?)\]\((.*?)\)/g, (match, linkText, url) => {
            const sanitizedUrl = url.trim();
            const invalidProtocols = /^(javascript|data):/i;
            if (invalidProtocols.test(sanitizedUrl)) {
                return match; // Don't render suspicious links
            }
            return `<a href="${sanitizedUrl}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
        });

        // Inline code `code`
        html = html.replace(/`(.*?)`/g, '<code>$1</code>');
        
        // Bold and Italic (combined) ***text*** or ___text___
        html = html.replace(/\*\*\*(.*?)\*\*\*|___(.*?)___/g, '<strong><em>$1$2</em></strong>');
        
        // Bold **text** or __text__
        html = html.replace(/\*\*(.*?)\*\*|__(.*?)__/g, '<strong>$1$2</strong>');

        // Italic *text* or _text_
        html = html.replace(/\*(.*?)\*|_(.*?)_/g, '<em>$1$2</em>');

        // Strikethrough ~~text~~
        html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');
        
        return html;
    }

    updateMarkdownEditor() {
        if (!this.nodes[ROOT_NODE_ID]) return;
        const markdown = this.exportToMarkdown(true); // Exclude styles for editor
        if (this.markdownEditor.value !== markdown) {
            this.markdownEditor.value = markdown;
        }
    }
    
    updateMapFromMarkdown() {
        const newMarkdown = this.markdownEditor.value;
        const currentMarkdownForEditor = this.exportToMarkdown(true);
        if (newMarkdown === currentMarkdownForEditor) {
            return;
        }

        const stateBefore = this.getSerializableState();

        const preservedState = {
            id: this.currentMapId,
            scale: this.scale,
            pan: this.pan,
            connectorStyle: this.connectorStyle,
            layoutMode: this.layoutMode
        };

        this.clearCanvas();
        this.currentMapId = preservedState.id;
        this.connectorStyle = preservedState.connectorStyle;
        this.layoutMode = preservedState.layoutMode;

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
        textSpan.innerHTML = this.renderMarkdown(text);
        nodeEl.appendChild(textSpan);

        nodeEl.addEventListener('mousedown', (e) => { 
            if (e.target.tagName === 'A') return;
            e.stopPropagation(); 
            this.handleDragStart(e, nodeId); 
        });
        nodeEl.addEventListener('dblclick', (e) => { e.stopPropagation(); if (this.selectedNodeIds.length === 1) this.makeNodeEditable(nodeId); });
        
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
                        textSpan.innerHTML = this.renderMarkdown(trimmedText);
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
        this.deleteNodeBtn.addEventListener('click', () => this.deleteSelectedNodes());
        this.newMapBtn.addEventListener('click', () => this.createNewMap());
        this.saveMapBtn.addEventListener('click', () => this.saveCurrentMap());
        this.uploadMapBtn.addEventListener('click', () => this.uploadInput.click());
        this.uploadInput.addEventListener('change', (e) => this.handleFileUpload(e));
        this.undoBtn.addEventListener('click', () => this.undo());
        this.redoBtn.addEventListener('click', () => this.redo());

        // Style buttons
        this.nodeStyleButtons.forEach(btn => btn.addEventListener('click', () => this.setNodeStyle(btn.dataset.style)));
        this.connectorStyleButtons.forEach(btn => btn.addEventListener('click', () => this.setConnectorStyle(btn.dataset.style)));
        this.layoutButtons.forEach(btn => btn.addEventListener('click', () => this.setLayoutMode(btn.dataset.layout)));


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
        this.markdownEditor.addEventListener('keydown', this.handleEditorKeyDown.bind(this));
        
        // Close open menus when clicking elsewhere
        document.addEventListener('click', (e) => {
            const openMenu = document.querySelector('.map-item-menu.open');
            if (openMenu && !openMenu.parentElement.contains(e.target)) {
                 openMenu.classList.remove('open');
            }
        });
    }

    handleEditorKeyDown(e) {
        const editor = e.target;
        const { selectionStart, selectionEnd, value } = editor;

        if (e.key === 'Tab') {
            e.preventDefault();

            const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
            const endPosForLineSearch = (selectionEnd > lineStart && value[selectionEnd - 1] === '\n') ? selectionEnd - 1 : selectionEnd;
            let lineEnd = value.indexOf('\n', endPosForLineSearch);
            if (lineEnd === -1) {
                lineEnd = value.length;
            }

            const textBefore = value.substring(0, lineStart);
            const selectedLinesText = value.substring(lineStart, lineEnd);
            const textAfter = value.substring(lineEnd);
            
            const lines = selectedLinesText.split('\n');
            let newSelectedLinesText;
            let startOffset = 0;
            let endOffset = 0;

            if (!e.shiftKey) { // Indent
                newSelectedLinesText = lines.map(line => '  ' + line).join('\n');
                startOffset = 2;
                endOffset = 2 * lines.length;
            } else { // Outdent
                let firstLineCharsRemoved = 0;
                let totalCharsRemoved = 0;
                newSelectedLinesText = lines.map((line, index) => {
                    if (line.startsWith('  ')) {
                        if (index === 0) firstLineCharsRemoved = 2;
                        totalCharsRemoved += 2;
                        return line.substring(2);
                    } else if (line.startsWith(' ')) {
                        if (index === 0) firstLineCharsRemoved = 1;
                        totalCharsRemoved += 1;
                        return line.substring(1);
                    }
                    return line;
                }).join('\n');
                startOffset = -firstLineCharsRemoved;
                endOffset = -totalCharsRemoved;
            }

            editor.value = textBefore + newSelectedLinesText + textAfter;
            editor.selectionStart = selectionStart + startOffset;
            editor.selectionEnd = selectionEnd + endOffset;

            this.updateMapFromMarkdownDebounced();
            return;
        }

        if (e.key === 'Enter') {
            if (selectionStart !== selectionEnd) return;

            e.preventDefault();
            
            const lineStartPos = value.lastIndexOf('\n', selectionStart - 1) + 1;
            let lineEndPos = value.indexOf('\n', selectionStart);
            if (lineEndPos === -1) lineEndPos = value.length;
            
            const currentLine = value.substring(lineStartPos, lineEndPos);
            const indentMatch = currentLine.match(/^\s*/);
            const indent = indentMatch ? indentMatch[0] : '';

            // If current line is an empty list item (e.g., "  - "), outdent on Enter
            if (/^\s*-\s*$/.test(currentLine)) {
                const parentIndent = indent.length >= 2 ? indent.substring(0, indent.length - 2) : '';
                const textBefore = value.substring(0, lineStartPos);
                const textAfter = value.substring(lineEndPos);

                editor.value = textBefore + parentIndent + textAfter;
                editor.selectionStart = editor.selectionEnd = textBefore.length + parentIndent.length;
            } else {
                const newContent = `\n${indent}- `;
                const textBefore = value.substring(0, selectionStart);
                const textAfter = value.substring(selectionEnd);
                
                editor.value = textBefore + newContent + textAfter;
                editor.selectionStart = editor.selectionEnd = selectionStart + newContent.length;
            }

            this.updateMapFromMarkdownDebounced();
            return;
        }
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
        if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.querySelector('#modal-overlay[style*="display: flex"]')) {
            return;
        }
        
        const isCtrl = e.ctrlKey || e.metaKey;

        if (isCtrl) {
            if (e.code === 'KeyA' || e.key === 'ф') { // 'ф' is 'a' in Persian layout
                e.preventDefault();
                this.selectAllNodes();
                return;
            }
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
        
        const activeNodeId = this.getActiveNodeId();
        if (!activeNodeId) return;

        switch (e.key) {
            case 'Tab':
                e.preventDefault(); this.addNodeForSelected(); break;
            case 'F2':
                e.preventDefault(); 
                if (this.selectedNodeIds.length === 1) {
                    this.makeNodeEditable(activeNodeId);
                }
                break;
            case 'Delete':
            case 'Backspace':
                e.preventDefault(); this.deleteSelectedNodes(); break;
            case 'ArrowUp':
            case 'ArrowDown':
                e.preventDefault();
                this.navigateSibling(activeNodeId, e.key === 'ArrowDown');
                break;
            case 'ArrowLeft': // Shallower in hierarchy for RTL (to children)
                e.preventDefault();
                this.navigateChild(activeNodeId);
                break;
            case 'ArrowRight': // Deeper in hierarchy for RTL (to parent)
                e.preventDefault();
                this.navigateParent(activeNodeId);
                break;
        }
    }
    
    // --- Selection and Navigation ---

    getActiveNodeId() {
        return this.selectedNodeIds.length > 0 ? this.selectedNodeIds[this.selectedNodeIds.length - 1] : null;
    }
    
    clearSelection() {
        this.selectedNodeIds.forEach(id => {
            this.nodes[id]?.element.classList.remove('selected');
        });
        this.selectedNodeIds = [];
        this.navigationState = null;
    }
    
    selectNode(nodeId, multiSelect = false) {
        if (nodeId && this.isAnyAncestorCollapsed(nodeId)) return;

        const previouslySelected = new Set(this.selectedNodeIds);

        if (!multiSelect) {
            this.clearSelection();
            if (nodeId) {
                this.selectedNodeIds = [nodeId];
            }
        } else {
            if (previouslySelected.has(nodeId)) {
                this.selectedNodeIds = this.selectedNodeIds.filter(id => id !== nodeId);
            } else if (nodeId) {
                this.selectedNodeIds.push(nodeId);
            }
        }

        // Apply 'selected' class to all currently selected nodes
        this.selectedNodeIds.forEach(id => {
            this.nodes[id]?.element.classList.add('selected');
        });
        
        // Remove 'selected' from nodes that are no longer selected
        previouslySelected.forEach(id => {
            if(!this.selectedNodeIds.includes(id)) {
                this.nodes[id]?.element.classList.remove('selected');
            }
        });

        this.updateToolbarButtons();
    }
    
    selectAllNodes() {
        this.clearSelection();
        this.selectedNodeIds = Object.keys(this.nodes).filter(id => !this.isAnyAncestorCollapsed(id));
        this.selectedNodeIds.forEach(id => {
            this.nodes[id]?.element.classList.add('selected');
        });
        this.updateToolbarButtons();
        this.navigationState = null;
    }

    navigateParent(nodeId) {
        const node = this.nodes[nodeId];
        if (!node || !node.parentId) return;

        this.selectNode(node.parentId);
        this.navigationState = { lastNodeId: nodeId, direction: 'parent' };
    }

    navigateChild(nodeId) {
        const node = this.nodes[nodeId];
        if (!node) return;

        const lastSelectedId = this.navigationState?.lastNodeId;
        const lastDirection = this.navigationState?.direction;

        if (nodeId === ROOT_NODE_ID && lastDirection === 'parent' && this.nodes[lastSelectedId]) {
            const lastNode = this.nodes[lastSelectedId];
            const rootNode = this.nodes[ROOT_NODE_ID];
            const wasOnLeft = lastNode.position.x < rootNode.position.x;
            
            const oppositeChildren = rootNode.childrenIds.filter(id => {
                const childIsOnLeft = this.nodes[id].position.x < rootNode.position.x;
                return wasOnLeft ? !childIsOnLeft : childIsOnLeft;
            }).filter(id => !this.nodes[id].isCollapsed);

            if (oppositeChildren.length > 0) {
                oppositeChildren.sort((a, b) => this.nodes[a].position.y - this.nodes[b].position.y);
                this.selectNode(oppositeChildren[0]);
                this.navigationState = { lastNodeId: nodeId, direction: 'child' };
                return;
            }
        }
        
        if (!node.isCollapsed && node.childrenIds.length > 0) {
            const sortedChildren = [...node.childrenIds].sort((a,b) => this.nodes[a].position.y - this.nodes[b].position.y);
            this.selectNode(sortedChildren[0]);
            this.navigationState = { lastNodeId: nodeId, direction: 'child' };
        }
    }

    navigateSibling(nodeId, goDown) {
        const node = this.nodes[nodeId];
        if (!node || !node.parentId) return;

        const parent = this.nodes[node.parentId];
        const visibleSiblings = parent.childrenIds.filter(id => !this.isAnyAncestorCollapsed(id));
        if (visibleSiblings.length <= 1) return;

        const sortedSiblings = visibleSiblings.sort((a, b) => {
            return this.nodes[a].position.y - this.nodes[b].position.y;
        });

        const currentIndex = sortedSiblings.indexOf(nodeId);
        let nextIndex = goDown ? currentIndex + 1 : currentIndex - 1;

        if (nextIndex < 0) {
            nextIndex = sortedSiblings.length - 1;
        } else if (nextIndex >= sortedSiblings.length) {
            nextIndex = 0;
        }

        this.selectNode(sortedSiblings[nextIndex]);
        this.navigationState = null; // Reset nav state when moving between siblings
    }


    updateToolbarButtons() {
        const selectionCount = this.selectedNodeIds.length;
        const hasSelection = selectionCount > 0;
        const rootIsSelected = this.selectedNodeIds.includes(ROOT_NODE_ID);
    
        this.addNodeBtn.disabled = !hasSelection;
        this.deleteNodeBtn.disabled = !hasSelection;
        this.nodeStyleButtons.forEach(btn => btn.disabled = !hasSelection);
    
        if (!hasSelection) {
            this.addNodeBtn.title = 'برای افزودن شاخه، یک گره را انتخاب کنید';
            this.deleteNodeBtn.title = 'برای حذف، یک گره را انتخاب کنید';
            this.updateActiveNodeStyleButton(null);
        } else {
            this.addNodeBtn.title = 'افزودن شاخه به گره فعال';
            if (rootIsSelected && selectionCount === 1) {
                this.deleteNodeBtn.title = 'گره اصلی را نمی‌توان حذف کرد';
                this.deleteNodeBtn.disabled = true;
            } else if (rootIsSelected) {
                this.deleteNodeBtn.title = 'حذف گره‌های انتخاب‌شده (به‌جز اصلی)';
                this.deleteNodeBtn.disabled = false;
            }
             else {
                this.deleteNodeBtn.title = 'حذف گره(های) انتخاب‌شده';
                this.deleteNodeBtn.disabled = false;
            }
            const activeNode = this.nodes[this.getActiveNodeId()];
            const style = activeNode?.style || 'rect';
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
    
    updateActiveLayoutButton(mode) {
        this.layoutButtons.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.layout === mode);
        });
    }

    setNodeStyle(style) {
        if (this.selectedNodeIds.length === 0) return;
        const stateBefore = this.getSerializableState();

        this.selectedNodeIds.forEach(nodeId => {
            const node = this.nodes[nodeId];
            if (node) {
                const oldStyle = node.style || 'rect';
                node.style = style;
                node.element.classList.remove(`node-style-${oldStyle}`);
                node.element.classList.add(`node-style-${style}`);
            }
        });

        this.updateActiveNodeStyleButton(style);
        this.pushHistoryState(stateBefore);
        this.triggerAutoSave();
        this.updateMarkdownEditor();
        this.updateUIVisibilityAndConnectors(); // Redraw connectors on style change
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
    
    setLayoutMode(mode) {
        if (this.layoutMode === mode) return;
        const stateBefore = this.getSerializableState();

        this.layoutMode = mode;
        this.updateActiveLayoutButton(mode);
        this.applyLayout();

        this.pushHistoryState(stateBefore);
        this.triggerAutoSave();
    }
    
    _calculateLayoutPositions(parentId, parentX, parentY, forceDirection = null) {
        let positions = { [parentId]: { x: parentX, y: parentY } };
        const parent = this.nodes[parentId];
        if (!parent || parent.isCollapsed || parent.childrenIds.length === 0) {
            return positions;
        }
    
        const HORIZONTAL_SPACING = 180;
        const VERTICAL_SPACING = 80;
    
        const isBidirectionalRoot = (this.layoutMode === 'bidirectional' && parentId === ROOT_NODE_ID);
    
        if (isBidirectionalRoot) {
            const children = [...parent.childrenIds];
            const leftChildren = [], rightChildren = [];
            children.forEach((id, i) => (i % 2 === 0 ? leftChildren.push(id) : rightChildren.push(id)));
    
            leftChildren.forEach((childId, i) => {
                const yOffset = (i - (leftChildren.length - 1) / 2) * VERTICAL_SPACING;
                const newX = parentX - HORIZONTAL_SPACING;
                const newY = parentY + yOffset;
                positions = { ...positions, ...this._calculateLayoutPositions(childId, newX, newY, -1) };
            });
    
            rightChildren.forEach((childId, i) => {
                const yOffset = (i - (rightChildren.length - 1) / 2) * VERTICAL_SPACING;
                const newX = parentX + HORIZONTAL_SPACING;
                const newY = parentY + yOffset;
                positions = { ...positions, ...this._calculateLayoutPositions(childId, newX, newY, 1) };
            });
        } else {
            let direction = forceDirection;
            if (direction === null) {
                if (this.layoutMode === 'rtl') {
                    direction = -1;
                } else { // Fallback for Bidirectional non-root when not called recursively from the root
                    const root = this.nodes[ROOT_NODE_ID];
                    direction = parent.position.x < root.position.x ? -1 : 1;
                }
            }
    
            parent.childrenIds.forEach((childId, i) => {
                const yOffset = (i - (parent.childrenIds.length - 1) / 2) * VERTICAL_SPACING;
                const newX = parentX + (direction * HORIZONTAL_SPACING);
                const newY = parentY + yOffset;
                positions = { ...positions, ...this._calculateLayoutPositions(childId, newX, newY, direction) };
            });
        }
        return positions;
    }
    
    applyLayout() {
        if (!this.nodes[ROOT_NODE_ID]) return;
        const rootPosition = { ...this.nodes[ROOT_NODE_ID].position };
        const newPositions = this._calculateLayoutPositions(ROOT_NODE_ID, rootPosition.x, rootPosition.y);
    
        for (const id in newPositions) {
            this.updateNodePosition(id, newPositions[id]);
        }
        this.updateUIVisibilityAndConnectors();
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
            const stillSelected = this.selectedNodeIds.filter(id => !descendantIds.includes(id));
            
            // If the only selected node was a descendant, select the collapsed node
            if(this.selectedNodeIds.every(id => descendantIds.includes(id))) {
                 this.selectNode(nodeId);
            } else if (stillSelected.length !== this.selectedNodeIds.length) {
                 // Reselect remaining nodes
                 const currentSelection = [...stillSelected];
                 this.clearSelection();
                 currentSelection.forEach(id => this.selectNode(id, true));
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
                    
                    const btnOffset = '-0.375rem';
                    const btnSize = '0.75rem';

                    if (allToTheRight) {
                         Object.assign(collapseBtn.style, { right: btnOffset, top: '50%', transform: 'translateY(-50%)' });
                    } else if (allToTheLeft) {
                        Object.assign(collapseBtn.style, { left: btnOffset, top: '50%', transform: 'translateY(-50%)' });
                    } else {
                        Object.assign(collapseBtn.style, { left: '50%', bottom: btnOffset, transform: 'translateX(-50%)' });
                    }
                } else {
                    collapseBtn.style.display = 'none';
                }
            }
            const isVisible = !this.isAnyAncestorCollapsed(node.id);
            node.element.style.display = isVisible ? 'flex' : 'none';
            if (isVisible && node.parentId && this.nodes[node.parentId]) {
                this.drawConnector(this.nodes[node.parentId], node);
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

    drawConnector(parentNode, childNode) {
        const fromPos = parentNode.position;
        const toPos = childNode.position;

        let adjustedFromPos = { ...fromPos };
        let adjustedToPos = { ...toPos };
        const padding = 5; 

        // Adjust start point if parent has a style without a visible border
        if (parentNode.style === 'underline' || parentNode.style === 'none') {
            if (parentNode.element && parentNode.element.offsetWidth > 0) {
                const parentOffset = (parentNode.element.offsetWidth / 2) + padding;
                if (toPos.x > fromPos.x) { // Child is to the right
                    adjustedFromPos.x += parentOffset;
                } else { // Child is to the left
                    adjustedFromPos.x -= parentOffset;
                }
            }
        }

        // Adjust end point if child has a style without a visible border
        if (childNode.style === 'underline' || childNode.style === 'none') {
            if (childNode.element && childNode.element.offsetWidth > 0) {
                const childOffset = (childNode.element.offsetWidth / 2) + padding;
                if (toPos.x > fromPos.x) { // Child is to the right
                    adjustedToPos.x -= childOffset;
                } else { // Child is to the left
                    adjustedToPos.x += childOffset;
                }
            }
        }
        
        let connectorEl;
        switch (this.connectorStyle) {
            case 'curved':
                connectorEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                connectorEl.setAttribute('d', this.getCurvedPathData(adjustedFromPos, adjustedToPos));
                break;
            case 'stepped':
                connectorEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                connectorEl.setAttribute('d', this.getSteppedPathData(adjustedFromPos, adjustedToPos));
                break;
            case 'straight':
            default:
                connectorEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                connectorEl.setAttribute('x1', adjustedFromPos.x); connectorEl.setAttribute('y1', adjustedFromPos.y);
                connectorEl.setAttribute('x2', adjustedToPos.x); connectorEl.setAttribute('y2', adjustedToPos.y);
                break;
        }
        connectorEl.setAttribute('class', 'connector-line');
        this.svgLayer.appendChild(connectorEl);
    }
    
    handleDragStart(e, nodeId) {
        if (e.button !== 0) return;
        
        if (e.target.tagName === 'INPUT') return;
        
        this.dragStartState = this.getSerializableState();
        this.dragState = { isDraggingNode: true, hasDragged: false, nodeId: nodeId, lastMousePos: { x: e.clientX, y: e.clientY } };
    }

    handlePanStart(e) {
        if (e.target.closest('.mindmap-node') || e.target.closest('#markdown-editor') || e.button !== 0) return;
        e.preventDefault();
        this.panState = { isPanning: true, hasPanned: false, lastMousePos: { x: e.clientX, y: e.clientY } };
        this.canvas.classList.add('panning');
    }
    
    handleMouseMove(e) {
        if (this.panState.isPanning) {
            this.panState.hasPanned = true;
            const dx = e.clientX - this.panState.lastMousePos.x;
            const dy = e.clientY - this.panState.lastMousePos.y;
            this.pan.x += dx; this.pan.y += dy;
            this.updateTransform();
            this.panState.lastMousePos = { x: e.clientX, y: e.clientY };
        } else if (this.dragState.isDraggingNode) {
            this.dragState.hasDragged = true;
            const dx = (e.clientX - this.dragState.lastMousePos.x) / this.scale;
            const dy = (e.clientY - this.dragState.lastMousePos.y) / this.scale;
            
            const isCtrl = e.ctrlKey || e.metaKey;
            if (!this.selectedNodeIds.includes(this.dragState.nodeId)) {
                if(!isCtrl) {
                    this.selectNode(this.dragState.nodeId, false);
                } else {
                     this.selectNode(this.dragState.nodeId, true);
                }
            }
            
            this.selectedNodeIds.forEach(id => {
                this.moveNodeAndChildren(id, { dx, dy }, this.selectedNodeIds);
            });
            
            this.dragState.lastMousePos = { x: e.clientX, y: e.clientY };
        }
    }
    
    handleMouseUp(e) {
        if (this.panState.isPanning) {
            if (!this.panState.hasPanned) {
                this.clearSelection();
                this.updateToolbarButtons();
            }
            this.panState.isPanning = false; 
            this.canvas.classList.remove('panning');
        }
        if (this.dragState.isDraggingNode) {
            if (!this.dragState.hasDragged) {
                this.navigationState = null;
                this.selectNode(this.dragState.nodeId, e.ctrlKey || e.metaKey);
            } else {
                if(this.dragStartState) {
                    const endState = JSON.stringify(this.getSerializableState().nodes);
                    const startState = JSON.stringify(this.dragStartState.nodes);
                    if(endState !== startState) {
                        this.pushHistoryState(this.dragStartState);
                    }
                    this.dragStartState = null;
                }
                this.triggerAutoSave();
            }
            this.dragState.isDraggingNode = false; 
            this.dragState.nodeId = null;
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
        this.updateUIVisibilityAndConnectors(); // Redraw connectors after zoom
    }
    
    updateNodePosition(nodeId, position) {
        const node = this.nodes[nodeId];
        if (node) {
            node.position = position;
            node.element.style.left = `${position.x}px`;
            node.element.style.top = `${position.y}px`;
        }
    }

    moveNodeAndChildren(rootNodeId, delta, selectionGroup = []) {
        const selectionSet = new Set(selectionGroup);
        if (selectionSet.has(this.nodes[rootNodeId]?.parentId) && this.dragState.nodeId !== rootNodeId) {
            return;
        }
    
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
    
    _hideModal() {
        this.modalOverlay.style.display = 'none';
        this.modalTitle.innerHTML = '';
        this.modalBody.innerHTML = '';
        this.modalFooter.innerHTML = '';
    }

    _showModal(options) {
        return new Promise((resolve) => {
            const { title, body, buttons } = options;

            this.modalTitle.textContent = title;
            this.modalBody.innerHTML = body;
            this.modalFooter.innerHTML = ''; // Clear previous buttons

            const handleResolve = (value) => {
                cleanup();
                resolve(value);
            };

            const handleCancel = () => {
                cleanup();
                resolve(false); // Resolve with a falsy value for cancellations
            };
            
            buttons.forEach(btnConfig => {
                const button = document.createElement('button');
                button.textContent = btnConfig.text;
                button.className = `modal-btn ${btnConfig.class || 'default'}`;
                button.addEventListener('click', () => {
                    if (btnConfig.value === 'resolve') {
                        const input = this.modalBody.querySelector('#modal-input');
                        handleResolve(input ? input.value : true);
                    } else {
                        handleResolve(btnConfig.value);
                    }
                });
                this.modalFooter.appendChild(button);
            });
            
            const onKeyDown = (e) => {
                if(e.key === 'Enter') {
                    const primaryBtn = this.modalFooter.querySelector('.primary');
                    if (primaryBtn) primaryBtn.click();
                } else if(e.key === 'Escape') {
                    handleCancel();
                }
            };

            const onOverlayClick = (e) => {
                if (e.target === this.modalOverlay) {
                    handleCancel();
                }
            };

            const cleanup = () => {
                this.modalCloseBtn.removeEventListener('click', handleCancel);
                this.modalOverlay.removeEventListener('click', onOverlayClick);
                document.removeEventListener('keydown', onKeyDown, true);
                this._hideModal();
            };

            this.modalCloseBtn.addEventListener('click', handleCancel);
            this.modalOverlay.addEventListener('click', onOverlayClick);
            document.addEventListener('keydown', onKeyDown, true);

            this.modalOverlay.style.display = 'flex';

            const input = this.modalBody.querySelector('#modal-input');
            if (input) {
                input.focus();
                input.select();
            }
        });
    }

}

document.addEventListener('DOMContentLoaded', () => {
    new MindMap('mindmap-canvas');
});
