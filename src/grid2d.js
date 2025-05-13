async function initGrid2d() {
  // Инициализация WebGPU
  const canvas = document.querySelector("canvas");
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");

  // Настройка формата и размера канваса
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  // Размер сетки (количество ячеек)
  const gridSize = 10;
  // Масштаб (изначальный)
  let scale = 1.0;
  // Позиция камеры (смещение)
  let cameraPos = { x: 0, y: 0 };
  // Выделенные ячейки (Set для хранения индексов)
  const selectedCells = new Set();

  // Обработчик событий мыши
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const zoomSpeed = 0.1;
    scale += e.deltaY * -0.001 * zoomSpeed;
    scale = Math.max(0.1, Math.min(scale, 5.0)); // Ограничиваем масштаб
  });

  // Обработчик клика (выделение ячейки)
  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Преобразуем координаты мыши в координаты сетки
    const cellSize = (Math.min(canvas.width, canvas.height) / gridSize) * scale;
    const gridX = Math.floor((mouseX - cameraPos.x) / cellSize);
    const gridY = Math.floor((mouseY - cameraPos.y) / cellSize);

    // Добавляем/удаляем выделение
    const cellIndex = gridY * gridSize + gridX;
    if (selectedCells.has(cellIndex)) {
      selectedCells.delete(cellIndex);
    } else {
      selectedCells.add(cellIndex);
    }
  });

  // Шейдеры WGSL
  const shaderModule = device.createShaderModule({
    //language=wgsl
    code: `
      struct VertexInput {
        @location(0) position: vec2f,
        @builtin(instance_index) instance: u32,
      };

      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) cellIndex: u32,
      };
            
      struct GridUniforms {
        gridSize: u32,
        scale: f32,
        cameraPos: vec2f,
      };

      @group(0) @binding(0) var<uniform> gridUniforms: GridUniforms;

      @vertex
      fn vertexMain(input: VertexInput) -> VertexOutput {
        let cellSize = 2.0 / f32(gridUniforms.gridSize) * gridUniforms.scale;
        let cellPadding = cellSize * 0.05; // Отступ между ячейками

        let cellX = f32(input.instance % gridUniforms.gridSize);
        let cellY = f32(input.instance / gridUniforms.gridSize);

        var pos = input.position * (cellSize - cellPadding) + vec2f(cellX, cellY) * cellSize;
        pos = pos * 2.0 - 1.0; // Переводим в NDC (от -1 до 1)
        pos += gridUniforms.cameraPos; // Применяем смещение камеры

        var output: VertexOutput;
        output.position = vec4f(pos, 0.0, 1.0);
        output.cellIndex = input.instance;
        return output;
      }

      @fragment
      fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
        // Цвет по умолчанию (серый)
        var color = vec4f(0.7, 0.7, 0.7, 1.0);

        // Если ячейка выделена — красим в красный
        if (input.cellIndex == 42) { // Пример: выделяем ячейку 42
            color = vec4f(1.0, 0.0, 0.0, 1.0);
        }

        return color;
      }
      `,
  });

  // Создаём буфер для uniform-переменных
  const uniformBuffer = device.createBuffer({
    size: 16 + 4 + 8, // gridSize (u32) + scale (f32) + cameraPos (vec2f)
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Рендер-пайплайн
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
      buffers: [
        {
          arrayStride: 2 * 4, // vec2f
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        },
      ],
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format }],
    },
    primitive: { topology: "triangle-list" },
  });

  // Данные вершин (квадрат)
  const vertexData = new Float32Array([
    // Треугольник 1
    0.0, 0.0, 1.0, 0.0, 0.0, 1.0,
    // Треугольник 2
    1.0, 0.0, 1.0, 1.0, 0.0, 1.0,
  ]);
  const vertexBuffer = device.createBuffer({
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, vertexData);

  // Bind group
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  // Основной цикл рендеринга
  function render() {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: [0.1, 0.1, 0.1, 1.0],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    // Обновляем uniform-буфер
    const uniformData = new Float32Array([
      gridSize, // gridSize (u32)
      scale, // scale (f32)
      cameraPos.x,
      cameraPos.y, // cameraPos (vec2f)
    ]);
    device.queue.writeBuffer(uniformBuffer, 0, uniformData);

    // Рисуем сетку
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6, gridSize * gridSize); // 6 вершин на квадрат, gridSize² инстансов
    pass.end();

    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(render);
  }

  // Запускаем рендеринг
  render();
}

export default initGrid2d;
