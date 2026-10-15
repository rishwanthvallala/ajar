import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

public class FilesIO {
    public static void main(String[] args) throws IOException {
        Path dir = Files.createDirectories(Path.of("fio-out", "nested"));
        Path f = dir.resolve("data.csv");
        Files.write(f, List.of("name,score", "ada,90", "bob,72", "cy,85"), StandardCharsets.UTF_8);
        try (BufferedReader r = Files.newBufferedReader(f)) {
            System.out.println("header " + r.readLine());
            System.out.println("avg " + r.lines().mapToInt(l -> Integer.parseInt(l.split(",")[1])).average().orElse(0));
        }
        Files.writeString(dir.resolve("note.txt"), "héllo\nwörld\n");
        System.out.println(Files.readString(dir.resolve("note.txt")).length() + " " + Files.size(dir.resolve("note.txt")) + " bytes");
        try (FileWriter w = new FileWriter("fio-out/append.txt", true)) { w.write("one\n"); }
        try (FileWriter w = new FileWriter("fio-out/append.txt", true)) { w.write("two\n"); }
        System.out.println(Files.readAllLines(Path.of("fio-out/append.txt")));
        try (DataOutputStream out = new DataOutputStream(new FileOutputStream("fio-out/bin.dat"))) { out.writeInt(0xCAFEBABE); out.writeDouble(1.5); out.writeUTF("utf"); }
        try (DataInputStream in = new DataInputStream(new FileInputStream("fio-out/bin.dat"))) { System.out.println(Integer.toHexString(in.readInt()) + " " + in.readDouble() + " " + in.readUTF()); }
        try (Stream<Path> walk = Files.walk(Path.of("fio-out"))) { System.out.println(walk.map(p -> p.toString().replace('\\', '/')).sorted().collect(Collectors.toList())); }
        File legacy = new File("fio-out/nested/note.txt");
        System.out.println(legacy.exists() + " " + legacy.isFile() + " " + legacy.length() + " " + legacy.getName() + " " + legacy.getParentFile().getName());
        Files.move(dir.resolve("note.txt"), dir.resolve("moved.txt"), StandardCopyOption.REPLACE_EXISTING);
        Files.copy(dir.resolve("moved.txt"), dir.resolve("copied.txt"));
        System.out.println(Files.exists(dir.resolve("note.txt")) + " " + Files.exists(dir.resolve("copied.txt")));
        try { Files.readString(Path.of("no-such-file.txt")); } catch (NoSuchFileException e) { System.out.println("missing: " + e.getMessage()); }
        try { new FileReader("also-missing.txt"); } catch (FileNotFoundException e) { System.out.println("FNF: " + e.getMessage()); }
        try (Stream<Path> walk = Files.walk(Path.of("fio-out"))) { walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); }
        System.out.println("cleaned " + !Files.exists(Path.of("fio-out")));
        try (PrintStream ps = new PrintStream(new ByteArrayOutputStream())) { ps.print("x"); }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        new PrintWriter(bos, true).printf("%s=%d%n", "k", 5);
        System.out.print(bos.toString());
    }
}
