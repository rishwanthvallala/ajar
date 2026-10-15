public class Switches {
    sealed interface Shape permits Circle, Square {}
    record Circle(double r) implements Shape {}
    record Square(double s) implements Shape {}
    enum Color { RED, GREEN }
    static String name(Shape s) {
        return switch (s) {
            case Circle c -> "circle";
        };
    }
    static int code(Color c) {
        return switch (c) { case RED -> 1; };
    }
    public static void main(String[] args) {
        String text = """
            unclosed;
    }
}
