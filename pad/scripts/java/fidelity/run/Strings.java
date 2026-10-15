public class Strings {
    public static void main(String[] args) {
        String s = "Hello, World";
        System.out.println(s.toUpperCase() + " " + s.length() + " " + s.indexOf("World") + " " + s.charAt(4));
        System.out.println(String.join("-", "a", "b", "c") + " " + "  trim me ".strip() + "|" + "ab".repeat(3));
        System.out.println(s.substring(7) + " " + s.replace('l', 'L') + " " + s.contains("lo,") + " " + s.hashCode());
        System.out.printf("%5d|%-5d|%05d|%x|%o|%e|%.2f|%10.3f|%s|%c|%b|%%%n", 42, 42, 42, 255, 8, 12345.678, 3.14159, 2.71828, "str", 'z', true);
        System.out.println(String.format("%,d %+d %(d", 1234567, 5, -5));
        System.out.println("""
            Text block
              keeps indentation
            ends here""");
        StringBuilder sb = new StringBuilder("abc");
        sb.insert(0, "x").reverse().append(1.5).append('c').deleteCharAt(0);
        System.out.println(sb + " " + sb.length());
        System.out.println("a,b,,c".split(",").length + " " + java.util.Arrays.toString("a1b22c333".split("\\d+")));
        System.out.println("ünïcödé ✓ 日本 😀".length() + " ünïcödé ✓ 日本 😀");
        System.out.println(Integer.toBinaryString(10) + " " + Integer.toHexString(-1) + " " + Long.MAX_VALUE + " " + Integer.MIN_VALUE);
        System.out.println(Double.toString(0.1 + 0.2) + " " + (float) 1 / 3 + " " + 1e20 + " " + 100.0 + " " + Double.NaN + " " + 1.0 / 0);
        System.out.println(Integer.parseInt("-123") + Integer.valueOf(7) + " " + Double.parseDouble("2.5e3") + " " + Boolean.parseBoolean("TRUE"));
        System.out.println("compare " + "apple".compareTo("banana") + " " + "a".equalsIgnoreCase("A") + " " + "x".isBlank() + " " + "".isEmpty());
        char c = 'A'; c += 2;
        System.out.println(c + " " + (int) c + " " + Character.isDigit('5') + " " + Character.toLowerCase('Q') + " " + (char) 97);
        System.out.println("chars: " + "hello".chars().filter(ch -> ch == 'l').count());
    }
}
