async function _streamImageGeneration({ url, body, onProgress, onDone, onError }) {
    try {
        const response = await fetch(`${BASE_URL}/${url}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            
            if (value) {
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); 

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    try {
                        const data = JSON.parse(trimmed.slice(6));
                        if (data.type === 'progress') onProgress?.(data.step, data.total);
                        else if (data.type === 'done') onDone?.(data.image);
                        else if (data.type === 'error') onError?.(data.error);
                    } catch (e) { 
                        console.error('Error parsing stream chunk:', trimmed, e); 
                    }
                }
            }

            if (done) {
                const trimmedBuffer = buffer.trim();
                if (trimmedBuffer.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(trimmedBuffer.slice(6));
                        if (data.type === 'progress') onProgress?.(data.step, data.total);
                        else if (data.type === 'done') onDone?.(data.image);
                        else if (data.type === 'error') onError?.(data.error);
                    } catch (e) { 
                        console.error('Error parsing final buffer:', trimmedBuffer, e); 
                    }
                }
                return;
            }
        }
    } catch (error) {
        onError?.(error);
    }
}

function openAvatarGenerator(target) {
    avatarGeneratorTarget = target;
    selectedAvatarType = 'portrait';
    generatedAvatarData = null;

    const modal = document.getElementById('avatarGeneratorModal');
    const preview = document.getElementById('generatorPreview');
    const applyBtn = document.getElementById('applyAvatarBtn');
    const generateBtn = document.getElementById('generateAvatarBtn');

    let currentImage = null;
    if (target === 'character' && characterImage) {
        currentImage = characterImage;
    } else if (target === 'persona' && personaImage) {
        currentImage = personaImage;
    }

    if (currentImage) {
        preview.innerHTML = `<img src="${currentImage}" alt="Preview">`;
        preview.classList.add('clickable');
        preview.onclick = () => openAvatarModal(currentImage);
    } else {
        preview.innerHTML = '<div class="image-preview-placeholder">Empty</div>';
        preview.classList.remove('clickable');
        preview.onclick = null;
    }

    if (!isSdLoaded) {
        generateBtn.disabled = true;
        generateBtn.innerHTML = '<img src="/static/icons/warning.svg" alt="warning" class="btn-icon"> Load the image model';
    } else {
        generateBtn.disabled = false;
        generateBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24"><use href="#icon-generate-sparkles"/></svg> Generate';
    }

    applyBtn.classList.add('hidden');
    document.getElementById('avatarPrompt').value = '';

    document.querySelectorAll('.avatar-type-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.type === 'portrait') btn.classList.add('active');
    });

    modal.classList.add('active');
}

function closeAvatarGenerator() {
    _closeModalAnimated(document.getElementById('avatarGeneratorModal'), () => {
        avatarGeneratorTarget = null;
        generatedAvatarData = null;
    });
}

function selectAvatarType(type) {
    selectedAvatarType = type;
    document.querySelectorAll('.avatar-type-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.type === type) btn.classList.add('active');
    });
}

function applyGeneratedAvatar() {
    if (!generatedAvatarData) return;

    if (avatarGeneratorTarget === 'character') {
        characterImage = generatedAvatarData;
        document.getElementById('imagePreview').innerHTML = `<img src="${generatedAvatarData}" alt="Character">`;
    } else if (avatarGeneratorTarget === 'persona') {
        personaImage = generatedAvatarData;
        document.getElementById('personaImagePreview').innerHTML = `<img src="${generatedAvatarData}" alt="Persona">`;
    }

    closeAvatarGenerator();
}

function handleAvatarFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const imageData = e.target.result;
        generatedAvatarData = imageData;

        const preview = document.getElementById('generatorPreview');
        preview.innerHTML = `<img src="${imageData}" alt="Uploaded">`;
        preview.classList.add('clickable');
        preview.onclick = () => openAvatarModal(imageData);

        document.getElementById('applyAvatarBtn').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function handleAvatarPaste(event) {
    const items = (event.clipboardData || event.originalEvent.clipboardData).items;
    for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
            const blob = item.getAsFile();
            const reader = new FileReader();
            reader.onload = (e) => {
                const imageData = e.target.result;
                generatedAvatarData = imageData;

                const preview = document.getElementById('generatorPreview');
                preview.innerHTML = `<img src="${imageData}" alt="Pasted">`;
                preview.classList.add('clickable');
                preview.onclick = () => openAvatarModal(imageData);

                document.getElementById('applyAvatarBtn').classList.remove('hidden');
            };
            reader.readAsDataURL(blob);
            break; 
        }
    }
}

async function generateAvatar() {
    const prompt = document.getElementById('avatarPrompt').value.trim();
    if (!prompt) { showCustomAlert('Enter the character description'); return; }
    if (!isSdLoaded) { showCustomAlert('Load the image model first'); return; }

    const generateBtn = document.getElementById('generateAvatarBtn');
    const preview = document.getElementById('generatorPreview');
    const progressContainer = document.getElementById('avatarProgressContainer');
    const progressFill = document.getElementById('avatarProgressFill');
    const progressText = document.getElementById('avatarProgressText');

    generateBtn.disabled = true;
    generateBtn.innerHTML = '<img src="/static/icons/hourglass.svg" alt="loading" class="btn-icon"> Generating...';
    preview.innerHTML = '<div class="image-preview-placeholder">Generating...</div>';
    preview.classList.remove('clickable');
    preview.onclick = null;
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = '0 / 30';

    await _streamImageGeneration({
        url: 'generate_avatar',
        body: { prompt, type: selectedAvatarType },
        onProgress: (step, total) => {
            progressFill.style.width = `${(step / total) * 100}%`;
            progressText.textContent = `${step} / ${total}`;
        },
        onDone: (image) => {
            generatedAvatarData = image;
            preview.innerHTML = `<img src="${image}" alt="Generated">`;
            preview.classList.add('clickable');
            preview.onclick = () => openAvatarModal(image);
            progressContainer.classList.add('hidden');
            document.getElementById('applyAvatarBtn').classList.remove('hidden');
        },
        onError: (err) => {
            showCustomAlert('Generation error: ' + err);
            preview.innerHTML = '<div class="image-preview-placeholder">Error</div>';
            progressContainer.classList.add('hidden');
        }
    });

    generateBtn.disabled = false;
    generateBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24"><use href="#icon-generate-sparkles"/></svg> Generate';
}

async function generateImage() {
    const prompt = document.getElementById('imageGenPrompt').value.trim();
    if (!prompt) { showCustomAlert('Enter a description'); return; }
    if (!isSdLoaded) { showCustomAlert('Load the image model first'); return; }

    const steps = parseInt(document.getElementById('imageGenSteps').value);
    const btn = document.getElementById('imageGenBtn');
    const preview = document.getElementById('imageGenPreview');
    const progressContainer = document.getElementById('imageGenProgressContainer');
    const progressFill = document.getElementById('imageGenProgressFill');
    const progressText = document.getElementById('imageGenProgressText');
    const saveBtn = document.getElementById('imageGenSaveBtn');

    btn.disabled = true;
    btn.innerHTML = '<img src="/static/icons/hourglass.svg" alt="loading" class="btn-icon"> Generating...';
    saveBtn.classList.add('hidden');
    preview.innerHTML = '<div class="image-preview-placeholder">Generating...</div>';
    preview.classList.remove('clickable');
    preview.onclick = null;
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressText.textContent = `0 / ${steps}`;

    await _streamImageGeneration({
        url: 'generate_image',
        body: { prompt, steps },
        onProgress: (step, total) => {
            progressFill.style.width = `${(step / total) * 100}%`;
            progressText.textContent = `${step} / ${total}`;
        },
        onDone: (image) => {
            preview.innerHTML = `<img src="${image}" alt="Generated">`;
            preview.classList.add('clickable');
            preview.onclick = () => openAvatarModal(image);
            progressContainer.classList.add('hidden');
            saveBtn.classList.remove('hidden');
            saveBtn.dataset.image = image;
        },
        onError: (err) => {
            showCustomAlert('Error: ' + err);
            preview.innerHTML = '<div class="image-preview-placeholder">Error</div>';
            progressContainer.classList.add('hidden');
        }
    });

    btn.disabled = false;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24"><use href="#icon-generate-sparkles"/></svg> Generate';
}

function saveGeneratedImage() {
    const saveBtn = document.getElementById('imageGenSaveBtn');
    const imageData = saveBtn.dataset.image;
    if (!imageData) return;

    const link = document.createElement('a');
    link.href = imageData;
    link.download = `generated_${Date.now()}.png`;
    link.click();
}