/*
 * The class library javac compiles against, for the pad's fast javac.
 *
 *   java SdkBuilder.java <out.bin> <module>...
 *
 * Run by build-java.mjs inside the Corretto image the runtime's class library
 * comes from, so what a program is compiled against is what it runs against.
 * Every class of the named modules, every member of each, with no method
 * bodies and no debug data. Constant values, signatures, inner classes,
 * records, sealed hierarchies and annotations stay, because javac reads them —
 * a constant it cannot see is a constant it cannot inline, and the class file
 * would differ from HotSpot's javac's. Private members stay too: without them
 * `new Math()` is "cannot find symbol" rather than javac's "Math() has private
 * access in Math". Two kinds of member go, because javac never sees them: the
 * synthetic ones its class reader does not enter (all but bridges and lambda
 * bodies), and private ones in packages no module exports, which a program
 * cannot name.
 *
 * teavm-javac takes its class library as one module, java.base, so the
 * module-info written here is java.base's, exporting every package any of the
 * modules exports to everyone. The archive is teavm-javac's: gzip around
 * (u2 name length, name, u4 data length, data) per entry.
 */

import java.io.DataOutputStream;
import java.io.IOException;
import java.lang.classfile.Attribute;
import java.lang.classfile.ClassElement;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.FieldModel;
import java.lang.classfile.MethodModel;
import java.lang.classfile.attribute.CodeAttribute;
import java.lang.classfile.attribute.ModuleAttribute;
import java.lang.constant.ModuleDesc;
import java.lang.constant.PackageDesc;
import java.lang.reflect.AccessFlag;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.zip.GZIPOutputStream;

public class SdkBuilder {
    /** What javac reads from a class it compiles against; everything else goes. */
    private static final Set<String> KEPT = Set.of(
            "Signature", "Exceptions", "ConstantValue", "InnerClasses", "EnclosingMethod",
            "Record", "PermittedSubclasses", "AnnotationDefault", "Deprecated", "Synthetic",
            "MethodParameters", "RuntimeVisibleAnnotations", "RuntimeInvisibleAnnotations",
            "RuntimeVisibleParameterAnnotations", "RuntimeInvisibleParameterAnnotations",
            "RuntimeVisibleTypeAnnotations", "RuntimeInvisibleTypeAnnotations");

    public static void main(String[] args) throws IOException {
        var out = Path.of(args[0]);
        var modules = List.of(args).subList(1, args.length);
        var jrt = FileSystems.getFileSystem(URI.create("jrt:/"));
        var classFile = ClassFile.of();
        var entries = new TreeMap<String, byte[]>();
        var exported = new TreeSet<String>();
        long before = 0;
        for (var module : modules) {
            var descriptor = ModuleLayer.boot().findModule(module).orElseThrow(
                    () -> new IllegalArgumentException("no module " + module)).getDescriptor();
            var open = new TreeSet<String>();
            for (var export : descriptor.exports()) {
                if (!export.isQualified()) {
                    exported.add(export.source());
                    open.add(export.source());
                }
            }
            var root = jrt.getPath("/modules", module);
            try (var walk = Files.walk(root)) {
                for (var path : (Iterable<Path>) walk::iterator) {
                    var name = root.relativize(path).toString();
                    if (!name.endsWith(".class") || name.equals("module-info.class")) {
                        continue;
                    }
                    var bytes = Files.readAllBytes(path);
                    before += bytes.length;
                    var pkg = name.contains("/") ? name.substring(0, name.lastIndexOf('/')).replace('/', '.') : "";
                    entries.put(name, api(classFile, classFile.parse(bytes), open.contains(pkg)));
                }
            }
        }
        var moduleInfo = classFile.buildModule(ModuleAttribute.of(ModuleDesc.of("java.base"), module -> {
            for (var pkg : exported) {
                module.exports(PackageDesc.of(pkg), Set.<AccessFlag>of());
            }
        }));
        entries.put("module-info.class", moduleInfo);

        long after = 0;
        try (var output = new DataOutputStream(new GZIPOutputStream(Files.newOutputStream(out)))) {
            for (var entry : entries.entrySet()) {
                var name = entry.getKey().getBytes(StandardCharsets.UTF_8);
                output.writeShort(name.length);
                output.write(name);
                output.writeInt(entry.getValue().length);
                output.write(entry.getValue());
                after += entry.getValue().length;
            }
        }
        System.out.printf("%d classes, %d packages exported, %.1f MB of classes as %.1f MB of API, %.1f MB gzipped%n",
                entries.size() - 1, exported.size(), before / 1e6, after / 1e6, Files.size(out) / 1e6);
    }

    /** Whether javac would ever see this member. */
    private static boolean seen(int flags, String name, boolean exported) {
        if ((flags & ClassFile.ACC_SYNTHETIC) != 0 && (flags & ClassFile.ACC_BRIDGE) == 0
                && !name.startsWith("lambda$")) {
            return false;
        }
        return exported || (flags & ClassFile.ACC_PRIVATE) == 0;
    }

    /** The class as javac sees it from another package. */
    private static byte[] api(ClassFile classFile, ClassModel model, boolean exported) {
        return classFile.build(model.thisClass().asSymbol(), builder -> {
            builder.withVersion(model.majorVersion(), model.minorVersion());
            builder.withFlags(model.flags().flagsMask());
            model.superclass().ifPresent(builder::withSuperclass);
            builder.withInterfaces(model.interfaces());
            for (ClassElement element : model) {
                switch (element) {
                    case FieldModel field when seen(field.flags().flagsMask(), field.fieldName().stringValue(), exported) -> builder.withField(
                            field.fieldName(), field.fieldType(), fb -> {
                                fb.withFlags(field.flags().flagsMask());
                                for (var e : field) {
                                    if (e instanceof Attribute<?> a && KEPT.contains(a.attributeName().stringValue())) {
                                        fb.with(e);
                                    }
                                }
                            });
                    case MethodModel method when seen(method.flags().flagsMask(), method.methodName().stringValue(), exported) -> builder.withMethod(
                            method.methodName(), method.methodType(), method.flags().flagsMask(), mb -> {
                                for (var e : method) {
                                    if (!(e instanceof CodeAttribute) && e instanceof Attribute<?> a
                                            && KEPT.contains(a.attributeName().stringValue())) {
                                        mb.with(e);
                                    }
                                }
                            });
                    case Attribute<?> attribute when KEPT.contains(attribute.attributeName().stringValue()) ->
                            builder.with(element);
                    default -> { }
                }
            }
        });
    }
}
