import mainUseUniform from "./mainUseUniform.js";
import init2dgrid from "./grid2d.js";
// import testDraw from "./testDraw.js";

async function main() {
  const adapter = await navigator.gpu?.requestAdapter();
  const device = await adapter?.requestDevice();
  if (!device) {
    fail("need a browser that supports WebGPU");
    return;
  }

  // Get a WebGPU context from the canvas and configure it
  const canvas = document.querySelector("canvas");
  const context = canvas.getContext("webgpu");
  const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentationFormat,
  });

  const vsModule = device.createShaderModule({
    label: "hardcoded triangle",
    //language=wgsl
    code: `
      struct OurVertexShaderOutput {
        @builtin(position) position: vec4f,
      };

      @vertex fn vs(
        @builtin(vertex_index) vertexIndex : u32
      ) -> OurVertexShaderOutput {
        let pos = array(
          vec2f( 0.0,  0.5),  // top center
          vec2f(-0.5, -0.5),  // bottom left
          vec2f( 0.5, -0.5)   // bottom right
        );

        var vsOutput: OurVertexShaderOutput;
        vsOutput.position = vec4f(pos[vertexIndex], 0.0, 1.0);
        return vsOutput;
      }
    `,
  });

  const module = device.createShaderModule({
    label: "triangle shaders with uniforms",
    //language=wgsl
    code: `
      struct OurStruct {
        color: vec4f,
        scale: vec2f,
        offset: vec2f,
      };
 
      @group(0) @binding(0) var<uniform> ourStruct: OurStruct;
      
      @vertex fn vs(
        @builtin(vertex_index) vertexIndex : u32
      ) -> @builtin(position) vec4f {
        let pos = array(
          vec2f( 0.0,  0.5),  // top center
          vec2f(-0.5, -0.5),  // bottom left
          vec2f( 0.5, -0.5)   // bottom right
        );
 
        return vec4f(pos[vertexIndex] * ourStruct.scale + ourStruct.offset, 0.0, 1.0);
      }
 
      @fragment fn fs() -> @location(0) vec4f {
        return ourStruct.color;
      }
    `,
  });

  const fsModule = device.createShaderModule({
    label: "checkerboard",
    //language=wgsl
    code: `
      @fragment fn fs(@builtin(position) pixelPosition: vec4f) -> @location(0) vec4f {
        let red = vec4f(1, 0, 0, 1);
        let cyan = vec4f(0, 1, 1, 1);

        let grid = vec2u(pixelPosition.xy) / 16;
        let checker = (grid.x + grid.y) % 2 == 1;

        return select(red, cyan, checker);
      }
    `,
  });

  const pipeline = device.createRenderPipeline({
    label: "hardcoded checkerboard triangle pipeline",
    layout: "auto",
    vertex: {
      module: vsModule,
    },
    fragment: {
      module: fsModule,
      targets: [{ format: presentationFormat }],
    },
  });

  const renderPassDescriptor = {
    label: "our basic canvas renderPass",
    colorAttachments: [
      {
        // view: <- to be filled out when we render
        clearValue: [0.3, 0.3, 0.3, 1],
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  };

  function render() {
    // Get the current texture from the canvas context and
    // set it as the texture to render to.
    renderPassDescriptor.colorAttachments[0].view = context
      .getCurrentTexture()
      .createView();

    const encoder = device.createCommandEncoder({ label: "our encoder" });
    const pass = encoder.beginRenderPass(renderPassDescriptor);
    pass.setPipeline(pipeline);
    pass.draw(3); // call our vertex shader 3 times
    pass.end();

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);
  }

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const canvas = entry.target;
      const width = entry.contentBoxSize[0].inlineSize;
      const height = entry.contentBoxSize[0].blockSize;
      canvas.width = Math.max(
        1,
        Math.min(width, device.limits.maxTextureDimension2D),
      );
      canvas.height = Math.max(
        1,
        Math.min(height, device.limits.maxTextureDimension2D),
      );
      // re-render
      render();
    }
  });
  observer.observe(canvas);
}

function fail(msg) {
  // eslint-disable-next-line no-alert
  alert(msg);
}

// main();

mainUseUniform();

// init2dgrid();
