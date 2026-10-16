"""CodeT5-small as transformers.js loads it, at the sizes the lab compares.

Run by build-models.sh, in a container: torch and the exporter never touch
the machine. Writes, under /out:

    codet5-small-q8/   8-bit everywhere: matrices and the vocabulary table
    codet5-small-q4/   4-bit matrices, the vocabulary table at 8 bits
    codet5-small-q4e4/ 4-bit matrices and a 4-bit vocabulary table, in blocks
                       of 128 rather than 32: one scale per 128 weights, so
                       about 4.25 bits a weight rather than 5. The smallest
                       this model gets without changing its vocabulary

each with config.json, the tokenizer, and onnx/encoder_model_<s>.onnx and
onnx/decoder_model_merged_<s>.onnx, named the way transformers.js asks for a
dtype ("q8" -> _quantized, "q4" -> _q4).

The vocabulary table is the point. A standard 4-bit conversion quantizes
only the matrix multiplications and leaves the embedding at 32 bits: 32,100
tokens by 512 is 66 MB, twice over (the encoder and the decoder each hold
one), which by itself is most of a model this size.
"""

import json
import os
import shutil
import subprocess
import sys

import onnx
from onnxruntime.quantization import QuantType, quantize_dynamic

MODEL = "Salesforce/codet5-small"
OUT = "/out"
FP32 = "/work/fp32"
PARTS = ("encoder_model", "decoder_model_merged")


def export():
    subprocess.run(
        ["optimum-cli", "export", "onnx", "--model", MODEL, "--task", "text2text-generation-with-past", "--opset", "17", FP32],
        check=True,
    )


def mb(path):
    return os.path.getsize(path) / 1e6


def setup(name):
    """A model directory: everything but the weights, from the export."""
    target = os.path.join(OUT, name)
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(os.path.join(target, "onnx"))
    for f in os.listdir(FP32):
        if not f.endswith(".onnx") and not f.endswith(".onnx_data") and os.path.isfile(os.path.join(FP32, f)):
            shutil.copy(os.path.join(FP32, f), target)
    return target


def q8(part, out):
    quantize_dynamic(
        os.path.join(FP32, f"{part}.onnx"),
        out,
        weight_type=QuantType.QUInt8,
        op_types_to_quantize=["MatMul", "Gather"],
        extra_options={"EnableSubgraph": True},
    )


def axes_as_inputs(model):
    """ReduceMean and its kind took `axes` as an attribute until opset 18 and as an input after.

    The 4-bit vocabulary table needs the int4 type, so the quantizer moves the
    model to opset 21 — and leaves every ReduceMean as it was, which the
    runtime then refuses to load ("Unrecognized attribute: axes").
    """
    reduces = {"ReduceMean", "ReduceMax", "ReduceMin", "ReduceProd", "ReduceL1", "ReduceL2", "ReduceLogSum", "ReduceLogSumExp", "ReduceSumSquare"}

    def fix(graph):
        for node in graph.node:
            for attribute in node.attribute:
                if attribute.type == onnx.AttributeProto.GRAPH:
                    fix(attribute.g)
            axes = next((a for a in node.attribute if a.name == "axes"), None)
            if node.op_type not in reduces or axes is None:
                continue
            name = f"{node.name or node.output[0]}_axes"
            graph.initializer.append(onnx.helper.make_tensor(name, onnx.TensorProto.INT64, [len(axes.ints)], list(axes.ints)))
            node.input.append(name)
            node.attribute.remove(axes)

    fix(model.graph)
    return model


def q4(part, out, gather_bits):
    """4-bit matrices; then the vocabulary table at 8 bits, or at 4 when asked and possible."""
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    model = onnx.load(os.path.join(FP32, f"{part}.onnx"))
    ops = ("MatMul", "Gather") if gather_bits == 4 else ("MatMul",)
    kwargs = dict(block_size=128 if gather_bits == 4 else 32, is_symmetric=True)
    if gather_bits == 4:
        kwargs.update(op_types_to_quantize=ops, quant_axes=(("MatMul", 0), ("Gather", 1)))
    quantizer = MatMulNBitsQuantizer(model, **kwargs)
    quantizer.process()
    staged = out + ".stage.onnx"
    quantizer.model.save_model_to_file(staged, use_external_data_format=False)
    if gather_bits == 8:
        quantize_dynamic(
            staged,
            out,
            weight_type=QuantType.QUInt8,
            op_types_to_quantize=["Gather"],
            extra_options={"EnableSubgraph": True},
        )
        os.remove(staged)
    else:
        fixed = onnx.load(staged)
        if max(i.version for i in fixed.opset_import if i.domain in ("", "ai.onnx")) >= 18:
            axes_as_inputs(fixed)
        onnx.save(fixed, out)
        os.remove(staged)


def main():
    export()
    sizes = {}
    for name, build, suffix in (
        ("codet5-small-q8", lambda p, o: q8(p, o), "_quantized"),
        ("codet5-small-q4", lambda p, o: q4(p, o, 8), "_q4"),
        ("codet5-small-q4e4", lambda p, o: q4(p, o, 4), "_q4"),
    ):
        target = setup(name)
        try:
            for part in PARTS:
                build(part, os.path.join(target, "onnx", f"{part}{suffix}.onnx"))
        except Exception as e:  # noqa: BLE001 - one variant failing should not lose the others
            print(f"{name}: could not be made: {e}", file=sys.stderr)
            shutil.rmtree(target, ignore_errors=True)
            continue
        sizes[name] = {f: round(mb(os.path.join(target, "onnx", f)), 1) for f in sorted(os.listdir(os.path.join(target, "onnx")))}
    with open(os.path.join(OUT, "sizes.json"), "w") as f:
        json.dump(sizes, f, indent=2)
    print(json.dumps(sizes, indent=2))


if __name__ == "__main__":
    main()
