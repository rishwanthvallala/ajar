import java.util.*;
import java.nio.charset.StandardCharsets;

public class Misc {
    enum Planet {
        MERCURY(3.303e+23, 2.4397e6), EARTH(5.976e+24, 6.37814e6);
        final double mass, radius;
        Planet(double m, double r) { mass = m; radius = r; }
        double gravity() { return 6.67300E-11 * mass / (radius * radius); }
    }
    interface Greeter { String greet(String n); static Greeter polite() { return n -> "Dear " + n; } }
    static String classify(Object o) {
        return switch (o) {
            case null -> "null!";
            case Integer i when i < 0 -> "negative int";
            case Integer i -> "int " + i;
            case String s -> "string of " + s.length();
            case int[] a -> "int array " + a.length;
            default -> "something else";
        };
    }
    public static void main(String[] args) throws Exception {
        for (Planet p : Planet.values()) System.out.printf("%s %.2f %s%n", p, p.gravity(), p.name().charAt(0) + p.name().substring(1).toLowerCase());
        System.out.println(Greeter.polite().greet("Ada"));
        for (Object o : new Object[]{null, -3, 7, "hey", new int[4], 2.0}) System.out.println(classify(o));
        byte[] bytes = "héllo".getBytes(StandardCharsets.UTF_8);
        System.out.println(bytes.length + " " + Arrays.toString(bytes) + " " + new String(bytes, StandardCharsets.ISO_8859_1).length());
        System.out.println(Base64.getEncoder().encodeToString("pad java".getBytes()) + " " + new String(Base64.getDecoder().decode("aGk=")));
        System.out.println(UUID.nameUUIDFromBytes("x".getBytes()) + " " + HexFormat.of().formatHex(new byte[]{1, 2, (byte) 255}));
        var md = java.security.MessageDigest.getInstance("SHA-256");
        System.out.println(HexFormat.of().formatHex(md.digest("abc".getBytes())));
        var crc = new java.util.zip.CRC32(); crc.update("hello".getBytes()); System.out.println("crc " + crc.getValue());
        StringJoiner sj = new StringJoiner("|", "<", ">"); sj.add("a").add("b"); System.out.println(sj);
        BitSet bs = new BitSet(); bs.set(1); bs.set(5); bs.set(64); System.out.println(bs + " " + bs.cardinality());
        Properties props = new Properties(); props.load(new java.io.StringReader("a=1\nb = two\n# c\n")); System.out.println(new TreeMap<>(props));
        System.out.println(String.valueOf(new char[]{'o', 'k'}) + " " + "x".compareTo("y") + " " + Character.isLetterOrDigit('_') + " " + "Straße".toUpperCase() + " " + "İ".toLowerCase().length());
        Locale.setDefault(Locale.US);
        System.out.println(String.format("%,.2f", 1234567.891) + " " + java.text.NumberFormat.getCurrencyInstance(Locale.US).format(1234.5) + " " + java.text.NumberFormat.getPercentInstance().format(0.256));
        System.out.println(new java.text.DecimalFormat("#,##0.00").format(9876.5) + " " + new java.text.SimpleDateFormat("yyyy-MM-dd").format(new java.util.Date(0L)).length());
        int[][] tri = new int[5][];
        for (int i = 0; i < 5; i++) { tri[i] = new int[i + 1]; tri[i][0] = tri[i][i] = 1; for (int j = 1; j < i; j++) tri[i][j] = tri[i-1][j-1] + tri[i-1][j]; }
        for (int[] row : tri) System.out.println(" ".repeat(5 - row.length) + Arrays.toString(row));
        System.out.println(Objects.toString(null) + " " + Integer.valueOf(127) == "x" + " " + (Integer.valueOf(127) == Integer.valueOf(127)) + " " + (Integer.valueOf(1000).equals(1000)));
        char[] cs = "dcba".toCharArray(); Arrays.sort(cs); System.out.println(new String(cs) + " " + String.valueOf(cs, 1, 2));
        System.out.println(Integer.MAX_VALUE + 1 + " " + Long.MIN_VALUE / -1 + " " + Math.abs(Integer.MIN_VALUE) + " " + (0.0 == -0.0) + " " + Double.compare(0.0, -0.0) + " " + Math.addExact(1, 2));
    }
}
